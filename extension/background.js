// Service worker: routes requests from Claude (via the MCP bridge) and from the side panel
// to the Chrome driver and the Jev agent.
import { loadSettings, saveSettings, isBlocked, describe, DEFAULTS } from './lib/settings.js';
import { makeProvider } from './lib/provider.js';
import { runTask, findElement, checkPage } from './lib/agent.js';
import { ChromeDriver, releaseDebugger } from './lib/driver.js';
import { Bridge } from './lib/bridge.js';

const VERSION = chrome.runtime.getManifest().version;
const panels = new Set(); // open side panel ports
const tasks = new Map(); // taskId -> { abort, tabId, source, goal }
const confirms = new Map(); // confirmId -> resolve
let bridge;

// ---------- helpers ----------

function broadcast(msg) {
  for (const p of panels) { try { p.postMessage(msg); } catch {} }
}

async function currentTabId(params = {}) {
  if (params.tabId) {
    await chrome.tabs.get(params.tabId).catch(() => { throw new Error(`No tab with id ${params.tabId}. Call browser_tabs to list tabs.`); });
    return params.tabId;
  }
  const { claudeTab } = await chrome.storage.session.get('claudeTab');
  if (claudeTab) {
    const tab = await chrome.tabs.get(claudeTab).catch(() => null);
    if (tab) return tab.id;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active) return active.id;
  const [any] = await chrome.tabs.query({ active: true });
  if (!any) throw new Error('No open tab. Call browser_navigate with newTab: true.');
  return any.id;
}

async function rememberTab(tabId) {
  await chrome.storage.session.set({ claudeTab: tabId });
}

async function groupTab(tabId, settings) {
  if (!settings.groupTabs || !chrome.tabGroups) return;
  try {
    let { jevGroup } = await chrome.storage.session.get('jevGroup');
    const tab = await chrome.tabs.get(tabId);
    const group = jevGroup ? await chrome.tabGroups.get(jevGroup).catch(() => null) : null;
    if (group && group.windowId === tab.windowId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    } else {
      jevGroup = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(jevGroup, { title: 'Jev', color: 'orange' });
      await chrome.storage.session.set({ jevGroup });
    }
  } catch {}
}

async function driverFor(params, settings) {
  const tabId = await currentTabId(params);
  const tab = await chrome.tabs.get(tabId);
  if (isBlocked(settings, tab.url)) throw new Error(`${new URL(tab.url).hostname} is on the blocked list in Jev Browser Control settings.`);
  return new ChromeDriver(tabId, { inputMode: settings.inputMode, onTab: (id) => rememberTab(id) });
}

function checkUrl(url, settings) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs can be opened.');
  if (isBlocked(settings, url)) throw new Error(`${u.hostname} is on the blocked list in Jev Browser Control settings.`);
  return u.href;
}

async function brief(driver) {
  const page = await driver.observe({ viewportOnly: true, max: 80, textChars: 1500 });
  return { tabId: driver.tabId, page };
}

async function setBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#FA903E' }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

// ---------- the Jev task runner (shared by Claude and the side panel) ----------

async function startTask({ goal, details, url, tabId, newTab, maxSteps, maxSeconds, allowIrreversible }, { emit = () => {}, source }) {
  const settings = await loadSettings();
  if (!goal || !String(goal).trim()) throw new Error('Give Jev a goal.');
  let id = tabId;
  if (newTab) {
    if (!url) throw new Error('newTab needs a url.');
    const tab = await chrome.tabs.create({ url: checkUrl(url, settings), active: true });
    id = tab.id;
    await groupTab(id, settings);
  }
  const driver = await driverFor({ tabId: id }, settings);
  if (url && !newTab) {
    const current = (await chrome.tabs.get(driver.tabId)).url;
    if (current !== url) await driver.navigate(checkUrl(url, settings));
  }
  if (source === 'claude') await rememberTab(driver.tabId);

  const taskId = crypto.randomUUID();
  const abort = new AbortController();
  tasks.set(taskId, { abort, tabId: driver.tabId, source, goal });
  const provider = makeProvider(settings);
  const onEvent = (event) => {
    const e = { ...event, taskId, source };
    broadcast({ type: 'event', event: e });
    emit(e);
    if (event.type === 'action') setBadge(String(event.step));
  };
  // Irreversible clicks: the side panel asks the person; Claude's calls stop and report instead.
  const confirm = source === 'panel' ? ({ label, url: pageUrl }) => new Promise((resolve) => {
    const cid = crypto.randomUUID();
    confirms.set(cid, resolve);
    broadcast({ type: 'confirm', id: cid, taskId, label, url: pageUrl });
  }) : undefined;
  await setBadge('…');
  try {
    return await runTask({
      goal, details, driver, provider, signal: abort.signal, onEvent, confirm, allowIrreversible: !!allowIrreversible,
      settings: { ...settings, maxSteps: maxSteps || settings.maxSteps, maxSeconds: maxSeconds || settings.maxSeconds },
    });
  } finally {
    tasks.delete(taskId);
    await setBadge('');
    broadcast({ type: 'idle', taskId });
    setTimeout(() => releaseDebugger(driver.tabId), 30_000);
  }
}

// ---------- request handlers (method names used by the MCP server) ----------

const handlers = {
  async status() {
    const settings = await loadSettings();
    const tabId = await currentTabId().catch(() => null);
    const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    return { version: VERSION, extensionId: chrome.runtime.id, settings: describe(settings), current_tab: tab && { tabId: tab.id, url: tab.url, title: tab.title }, running_tasks: [...tasks.values()].map((t) => ({ goal: t.goal, tabId: t.tabId, source: t.source })) };
  },

  async 'tabs.list'() {
    const tabs = await chrome.tabs.query({});
    const { claudeTab } = await chrome.storage.session.get('claudeTab');
    return tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, current: t.id === claudeTab, title: t.title, url: t.url }));
  },

  async 'tabs.select'({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await rememberTab(tabId);
    return { tabId, url: tab.url, title: tab.title };
  },

  async 'tabs.close'({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { closed: tabId };
  },

  async navigate(params) {
    const settings = await loadSettings();
    const url = checkUrl(params.url, settings);
    if (params.newTab) {
      const tab = await chrome.tabs.create({ url, active: true });
      await rememberTab(tab.id);
      await groupTab(tab.id, settings);
      const driver = new ChromeDriver(tab.id, { inputMode: settings.inputMode });
      await driver.waitForLoad(15000);
      return brief(driver);
    }
    const driver = await driverFor(params, settings);
    await rememberTab(driver.tabId);
    await driver.navigate(url);
    return brief(driver);
  },

  async snapshot(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    await rememberTab(driver.tabId);
    const page = await driver.observe({ viewportOnly: !params.full, max: params.full ? 500 : 240, textChars: params.full ? 12000 : 6000 });
    return { tabId: driver.tabId, page };
  },

  async click(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    const r = await driver.click(Number(params.ref));
    await driver.settle({ kind: 'click', ref: Number(params.ref) });
    return { ...r, ...(await brief(driver)) };
  },

  async type(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    const r = await driver.fill(Number(params.ref), String(params.text ?? ''));
    await driver.settle({ kind: 'fill', ref: Number(params.ref) });
    if (params.submit) { await driver.pressKey('Enter', Number(params.ref)); await driver.settle({ kind: 'enter' }); }
    return { ...r, ...(await brief(driver)) };
  },

  async select(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    const r = await driver.select(Number(params.ref), { label: params.option, value: params.value });
    await driver.settle({ kind: 'select' });
    return { ...r, ...(await brief(driver)) };
  },

  async key(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    const r = await driver.pressKey(params.key, params.ref ? Number(params.ref) : undefined);
    await driver.settle({ kind: 'key' });
    return { ...r, ...(await brief(driver)) };
  },

  async scroll(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    await driver.scroll(params.direction || 'down', params.amount);
    return brief(driver);
  },

  async history(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    if (params.direction === 'forward') await driver.forward();
    else await driver.back();
    return brief(driver);
  },

  async wait(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    const until = Date.now() + Math.min(30, Number(params.seconds) || 5) * 1000;
    if (!params.text) { await new Promise((r) => setTimeout(r, until - Date.now())); return brief(driver); }
    while (Date.now() < until) {
      const r = await driver.read({ format: 'text', limit: 200000 }).catch(() => null);
      if (r?.content?.toLowerCase().includes(String(params.text).toLowerCase())) return { found: true, ...(await brief(driver)) };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { found: false, ...(await brief(driver)) };
  },

  async read(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    return driver.read({ format: params.format || 'markdown', offset: params.offset || 0, limit: Math.min(params.limit || 20000, 100000) });
  },

  async screenshot(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    return driver.screenshot({ quality: params.quality || 70 });
  },

  async 'jev.task'(params, ctx) {
    return startTask(params, ctx);
  },

  async 'jev.find'(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    return findElement({ description: params.description, driver, provider: makeProvider(settings), settings });
  },

  async 'jev.check'(params) {
    const settings = await loadSettings();
    const driver = await driverFor(params, settings);
    return checkPage({ statement: params.statement, driver, provider: makeProvider(settings), settings });
  },

  async 'jev.stop'() {
    for (const t of tasks.values()) t.abort.abort();
    return { stopped: tasks.size };
  },
};

async function onRequest(method, params, ctx) {
  const fn = handlers[method];
  if (!fn) throw new Error(`Unknown method ${method}. Update the Jev Browser Control extension.`);
  return fn(params, ctx);
}

// ---------- side panel ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
  const sendState = async () => {
    const settings = await loadSettings();
    port.postMessage({ type: 'state', bridge: { connected: bridge?.connected, port: settings.bridgePort, enabled: settings.bridgeEnabled }, settings: describe(settings), running: [...tasks.entries()].map(([id, t]) => ({ taskId: id, goal: t.goal, source: t.source, tabId: t.tabId })) });
  };
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'getState') return sendState();
    if (msg.type === 'stop') { for (const [id, t] of tasks) if (!msg.taskId || id === msg.taskId) t.abort.abort(); return; }
    if (msg.type === 'confirm') { confirms.get(msg.id)?.(!!msg.ok); confirms.delete(msg.id); return; }
    if (msg.type === 'run') {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await startTask({ goal: msg.goal, details: msg.details, tabId: tab?.id }, { source: 'panel' });
      } catch (err) {
        port.postMessage({ type: 'error', message: String(err.message || err) });
      }
    }
    if (msg.type === 'reconnect') bridge?.connect();
  });
  bridge?.connect();
  sendState();
});

// ---------- startup ----------

async function init() {
  const settings = await loadSettings();
  bridge ||= new Bridge({
    port: settings.bridgePort,
    version: VERSION,
    onRequest,
    onStatus: (s) => broadcast({ type: 'bridge', ...s }),
  });
  bridge.setEnabled(settings.bridgeEnabled);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !bridge) return;
  if (changes.bridgePort) bridge.setPort(changes.bridgePort.newValue ?? DEFAULTS.bridgePort);
  if (changes.bridgeEnabled) bridge.setEnabled(changes.bridgeEnabled.newValue !== false);
  loadSettings().then((s) => broadcast({ type: 'settings', settings: describe(s) }));
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('bridge', { periodInMinutes: 0.5 });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('bridge', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'bridge') init().then(() => bridge.connect()); });

// Settings page "Test" button and first-run checks.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'testProvider') {
    (async () => {
      const settings = { ...(await loadSettings()), ...(msg.settings || {}) };
      const provider = makeProvider(settings);
      const t0 = Date.now();
      const r = await provider.decide({ model: settings.jevModel, state: { note: 'connection test' }, questions: { ok: { type: 'noul', instructions: 'Is `note` a connection test?' } } });
      return { ok: true, model: r.model, ms: Date.now() - t0, cost: provider.cost, balance: provider.balance };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg?.type === 'saveSettings') {
    saveSettings(msg.patch).then((s) => sendResponse({ ok: true, settings: describe(s) }));
    return true;
  }
  return false;
});

init();
