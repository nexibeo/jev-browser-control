// Executes actions in a real Chrome tab.
// Input goes through the Chrome DevTools Protocol (chrome.debugger) by default, so clicks
// and typing are trusted events like a person's. If the debugger can't attach (DevTools is
// open, or the setting says "dom"), synthetic DOM events are used instead.
import { pageOp } from './page.js';
import { StaleError, fingerprint } from './agent.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_MAC = /Mac/i.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '');

// Tabs with the debugger attached, and when each was last used (detached after a quiet minute).
const attached = new Map();
let sweeper = null;
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

async function ensureDebugger(tabId) {
  if (attached.has(tabId)) { attached.set(tabId, Date.now()); return true; }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.set(tabId, Date.now());
    sweeper ||= setInterval(() => {
      for (const [id, t] of attached) if (Date.now() - t > 60_000) chrome.debugger.detach({ tabId: id }).catch(() => {}).finally(() => attached.delete(id));
      if (!attached.size) { clearInterval(sweeper); sweeper = null; }
    }, 15_000);
    return true;
  } catch {
    return false;
  }
}

export async function releaseDebugger(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

export class ChromeDriver {
  constructor(tabId, { inputMode = 'debugger', onTab } = {}) {
    this.tabId = tabId;
    this.inputMode = inputMode;
    this.onTab = onTab;
  }

  async run(op, arg, { retries = 20 } = {}) {
    for (let i = 0; ; i++) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: pageOp, args: [op, arg] });
        if (res?.result !== undefined && res.result !== null) return res.result;
        if (op !== 'observe') return res?.result;
      } catch (err) {
        const msg = String(err.message || err);
        if (/Cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\/|webstore|No tab with id/i.test(msg) || i >= retries) {
          throw new Error(/Cannot access|cannot be scripted|chrome:\/\/|webstore/i.test(msg) ? `This page can't be controlled by extensions (${msg}). Navigate to a normal website first.` : msg);
        }
      }
      if (i >= retries) throw new Error('The page did not become ready.');
      await sleep(100); // navigating: the frame was replaced mid-call
      await this.waitForLoad(3000);
    }
  }

  async waitForLoad(timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) throw new Error('The tab was closed.');
      if (tab.status === 'complete') return true;
      await sleep(50);
    }
    return false;
  }

  async useDebugger() {
    return this.inputMode !== 'dom' && ensureDebugger(this.tabId);
  }

  cdp(method, params) {
    attached.set(this.tabId, Date.now());
    return chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
  }

  async observe({ viewportOnly = true, max = 240, textChars = 6000 } = {}) {
    await this.waitForLoad(5000);
    const page = await this.run('observe', { viewportOnly, max, textChars });
    page.tabId = this.tabId;
    page.fingerprint = fingerprint(page);
    return page;
  }

  async prepare(ref, extra = {}) {
    const p = await this.run('prepare', { ref, ...extra });
    if (!p) throw new StaleError('The page is navigating.');
    if (p.error === 'stale') throw new StaleError(p.reason);
    if (p.error) throw new Error(p.reason || p.error);
    return p;
  }

  // Follow a link that opens a new tab: the agent continues there.
  async withNewTabWatch(fn) {
    const created = [];
    const listener = (tab) => { if (tab.openerTabId === this.tabId) created.push(tab.id); };
    chrome.tabs.onCreated.addListener(listener);
    try {
      await fn();
      await sleep(150);
    } finally {
      chrome.tabs.onCreated.removeListener(listener);
    }
    if (created.length) {
      this.tabId = created.at(-1);
      await chrome.tabs.update(this.tabId, { active: true }).catch(() => {});
      this.onTab?.(this.tabId);
    }
  }

  async click(ref, { guard, key, strict = false } = {}) {
    const p = await this.prepare(ref, { kind: 'click', guard, key, strict });
    await this.withNewTabWatch(async () => {
      if (await this.useDebugger()) {
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      } else {
        await this.run('domClick', { ref });
      }
    });
    return { clicked: p.label };
  }

  // Move the pointer onto an element without clicking (hover menus, reaction pickers, tooltips).
  async hover(ref) {
    const p = await this.prepare(ref, { kind: 'hover' });
    if (await this.useDebugger()) await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    else await this.run('domHover', { ref });
    return { hovered: p.label };
  }

  async fill(ref, text, { guard } = {}) {
    const p = await this.prepare(ref, { kind: 'fill', guard });
    if (p.formatted) {
      // date/time/month inputs ignore inserted text; set the ISO value the way a picker would.
      const r = await this.run('domFill', { ref, text });
      if (r?.error) throw new Error('Could not set the field.');
      if (text && !r.value) throw new Error(`The field rejected "${text}". Use the format it expects (e.g. 2026-10-20 for dates, 19:30 for times).`);
      return { typed: text, into: p.label };
    }
    if (await this.useDebugger()) {
      await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      const mod = IS_MAC ? 4 : 2;
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: mod, commands: ['selectAll'] });
      await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: mod });
      if (text) await this.cdp('Input.insertText', { text });
      else {
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
    } else {
      await this.run('domFill', { ref, text });
    }
    return { typed: text, into: p.label };
  }

  async select(ref, option) {
    const r = await this.run('select', { ref, value: option.value, label: option.label });
    if (r?.error === 'stale') throw new StaleError(r.reason);
    if (r?.error) throw new Error(r.reason);
    return r;
  }

  // key: "Enter", "Tab", "Escape", "ArrowDown", "a", or a combo like "Control+A" / "Meta+L".
  async pressKey(combo, ref) {
    const parts = String(combo).split('+');
    const name = parts.pop();
    const modifiers = parts.reduce((m, p) => m | (MODIFIERS[p] || 0), 0);
    const spec = KEYS[name] || (name.length === 1 ? { code: /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : '', keyCode: name.toUpperCase().charCodeAt(0), text: name } : null);
    if (!spec) throw new Error(`Unknown key "${name}"`);
    const key = spec.key || name;
    if (ref) await this.prepare(ref, { kind: 'key' }).catch(() => {});
    await this.withNewTabWatch(async () => {
      if (await this.useDebugger()) {
        const text = modifiers & ~8 ? undefined : spec.text;
        await this.cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, modifiers });
      } else {
        await this.run('domKey', { ref, key, code: spec.code });
      }
    });
    return { pressed: combo };
  }

  async scroll(direction = 'down', amount) {
    const page = await this.run('observe', { viewportOnly: true, max: 0, textChars: 0, contexts: false });
    const h = page?.viewport?.h || 800;
    const dy = (direction === 'up' ? -1 : 1) * (amount || Math.round(h * 0.8));
    if (await this.useDebugger()) {
      // A wheel event at the middle of the page also scrolls a nested scroll area under the pointer.
      await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round((page?.viewport?.w || 1200) / 2), y: Math.round(h * 0.6), deltaX: 0, deltaY: dy });
      await sleep(120);
    } else {
      await this.run('scroll', { dy });
    }
    return { scrolled: direction };
  }

  async back() {
    await chrome.tabs.goBack(this.tabId).catch(() => {});
    await sleep(100);
    await this.waitForLoad(8000);
  }

  async forward() {
    await chrome.tabs.goForward(this.tabId).catch(() => {});
    await sleep(100);
    await this.waitForLoad(8000);
  }

  async navigate(url) {
    await chrome.tabs.update(this.tabId, { url });
    await sleep(100);
    await this.waitForLoad(15000);
    const tab = await chrome.tabs.get(this.tabId);
    return { url: tab.url, title: tab.title };
  }

  async wait(ms = 100) { await sleep(ms); }

  // After an action: animation frames or an autocomplete, then any navigation it started.
  async settle(action = {}) {
    await this.run('settle', { ref: action.ref, kind: action.kind }, { retries: 3 }).catch(() => {});
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    if (tab?.status === 'loading') await this.waitForLoad(8000);
  }

  async read(opts) {
    await this.waitForLoad(5000);
    return this.run('read', opts);
  }

  async screenshot({ quality = 70 } = {}) {
    if (this.inputMode !== 'dom' && (await ensureDebugger(this.tabId))) {
      const { data } = await this.cdp('Page.captureScreenshot', { format: 'jpeg', quality });
      return { mimeType: 'image/jpeg', data };
    }
    const tab = await chrome.tabs.get(this.tabId);
    if (!tab.active) await chrome.tabs.update(this.tabId, { active: true });
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality });
    return { mimeType: 'image/jpeg', data: url.split(',')[1] };
  }
}
