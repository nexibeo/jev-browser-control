// Browser mode: the MCP server opens and drives its own Chrome through Playwright (no extension).
// It uses the installed Google Chrome with a separate profile that is kept between sessions,
// so a login you do once in that window stays. Jev's loop and the page code are the same files
// the extension uses (lib/core, copied from extension/lib).
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pageOp } from './core/page.js';
import { runTask, findElement, checkPage, StaleError, fingerprint } from './core/agent.js';
import { makeProvider } from './core/provider.js';
import { keySet, isBlocked, loadConfig } from './config.mjs';

const PAGE_OP = pageOp.toString();
const IS_MAC = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PlaywrightDriver {
  constructor(browser, page) {
    this.browser = browser;
    this.page = page;
  }

  get tabId() { return this.browser.idOf(this.page); }

  async run(op, arg = {}, { retries = 20 } = {}) {
    for (let i = 0; ; i++) {
      try {
        const r = await this.page.evaluate(`(${PAGE_OP})(${JSON.stringify(op)}, ${JSON.stringify(arg)})`);
        if (r !== null || op !== 'observe') return r;
      } catch (err) {
        if (this.page.isClosed()) throw new Error('The tab was closed.');
        if (i >= retries) throw err;
      }
      if (i >= retries) throw new Error('The page did not become ready.');
      await this.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      await sleep(100);
    }
  }

  async waitForLoad(timeout = 8000) {
    await this.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
  }

  async observe({ viewportOnly = true, max = 240, textChars = 6000 } = {}) {
    await this.waitForLoad(5000);
    // A task can click its way onto a blocked site; stop there before reading or acting on it.
    if (isBlocked(this.browser.config.settings, this.page.url())) throw new Error(`${new URL(this.page.url()).hostname} is on the blocked list (JBC_BLOCKED_SITES).`);
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

  // A click that opens a new tab moves the work to that tab.
  async withNewTab(fn) {
    const popup = this.page.context().waitForEvent('page', { timeout: 700 }).catch(() => null);
    await fn();
    const next = await popup;
    if (next) {
      await next.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      this.page = next;
      this.browser.setCurrent(next);
    }
  }

  async click(ref, { guard, key, strict = false } = {}) {
    const p = await this.prepare(ref, { kind: 'click', guard, key, strict });
    await this.withNewTab(() => this.page.mouse.click(p.x, p.y));
    return { clicked: p.label };
  }

  async fill(ref, text, { guard } = {}) {
    const p = await this.prepare(ref, { kind: 'fill', guard });
    if (p.formatted) {
      // date/time/month inputs ignore typed text; set the ISO value the way a picker would.
      const r = await this.run('domFill', { ref, text });
      if (text && !r?.value) throw new Error(`The field rejected "${text}". Use the format it expects (e.g. 2026-10-20 for dates, 19:30 for times).`);
      return { typed: text, into: p.label };
    }
    await this.page.mouse.click(p.x, p.y);
    await this.page.keyboard.press(IS_MAC ? 'Meta+A' : 'Control+A');
    if (text) await this.page.keyboard.insertText(text);
    else await this.page.keyboard.press('Backspace');
    return { typed: text, into: p.label };
  }

  async select(ref, option) {
    const r = await this.run('select', { ref, value: option.value, label: option.label });
    if (r?.error === 'stale') throw new StaleError(r.reason);
    if (r?.error) throw new Error(r.reason);
    return r;
  }

  async pressKey(combo, ref) {
    if (ref) await this.prepare(ref, { kind: 'key' }).then((p) => this.page.mouse.click(p.x, p.y)).catch(() => {});
    const key = String(combo).replace(/\b(Ctrl)\b/g, 'Control').replace(/\b(Cmd|Command)\b/g, 'Meta').replace(/^Space$/, ' ');
    await this.withNewTab(() => this.page.keyboard.press(key));
    return { pressed: combo };
  }

  async scroll(direction = 'down', amount) {
    const { w, h } = await this.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await this.page.mouse.move(Math.round(w / 2), Math.round(h * 0.6));
    await this.page.mouse.wheel(0, (direction === 'up' ? -1 : 1) * (amount || Math.round(h * 0.8)));
    await sleep(150);
    return { scrolled: direction };
  }

  async back() { await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}); }
  async forward() { await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}); }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { url: this.page.url(), title: await this.page.title() };
  }

  async wait(ms = 100) { await sleep(ms); }

  async settle(action = {}) {
    await this.run('settle', { ref: action.ref, kind: action.kind }, { retries: 3 }).catch(() => {});
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  }

  async read(opts) {
    await this.waitForLoad(5000);
    return this.run('read', opts);
  }

  async screenshot({ quality = 70 } = {}) {
    const buf = await this.page.screenshot({ type: 'jpeg', quality });
    return { mimeType: 'image/jpeg', data: buf.toString('base64') };
  }
}

export class LocalBrowser {
  constructor(config, { version, log = () => {} } = {}) {
    this.config = config;
    this.version = version;
    this.log = log;
    this.context = null;
    this.launching = null;
    this.current = null;
    this.ids = new WeakMap();
    this.nextId = 1;
    this.tasks = new Map();
  }

  idOf(page) {
    if (!this.ids.has(page)) this.ids.set(page, this.nextId++);
    return this.ids.get(page);
  }

  setCurrent(page) { this.current = page; }

  async ensure() {
    if (this.context) return this.context;
    this.launching ||= this.launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async launch() {
    let chromium;
    try { ({ chromium } = await import('playwright-core')); } catch {
      throw new Error('playwright-core is not installed next to the MCP server. Run `npm install` in the jev-browser-control folder (or use the npx package).');
    }
    const b = this.config.browser;
    mkdirSync(b.profileDir, { recursive: true });
    const base = {
      headless: b.headless,
      viewport: null,
      args: ['--window-size=1280,900', '--no-first-run', '--no-default-browser-check'],
    };
    let context;
    try {
      context = await chromium.launchPersistentContext(b.profileDir, b.chromePath ? { ...base, executablePath: b.chromePath } : { ...base, channel: b.channel });
    } catch (err) {
      const msg = String(err.message || err);
      if (/ProcessSingleton|SingletonLock|already in use/i.test(msg)) throw new Error(`The browser profile ${b.profileDir} is in use by another Chrome. Close that window (or set JBC_PROFILE_DIR) and retry.`);
      if (/distribution .* is not found|Executable doesn't exist/i.test(msg)) throw new Error('Google Chrome was not found. Install it, or set CHROME_PATH in ~/.jev-browser-control/config.env to a Chrome or Chromium binary.');
      throw err;
    }
    this.context = context;
    context.on('close', () => { if (this.context === context) { this.context = null; this.current = null; } });
    context.on('page', (p) => this.idOf(p));
    this.current = context.pages()[0] || (await context.newPage());
    this.log(`browser ready (${b.chromePath || b.channel}, profile ${b.profileDir})`);
    return context;
  }

  async page(tabId) {
    const context = await this.ensure();
    const pages = context.pages();
    if (tabId !== undefined && tabId !== null) {
      const p = pages.find((x) => this.idOf(x) === Number(tabId));
      if (!p) throw new Error(`No tab with id ${tabId}. Call browser_tabs to list tabs.`);
      return p;
    }
    if (!this.current || this.current.isClosed()) this.current = pages.at(-1) || (await context.newPage());
    return this.current;
  }

  async driver(params = {}) {
    const page = await this.page(params.tabId);
    if (isBlocked(this.config.settings, page.url())) throw new Error(`${new URL(page.url()).hostname} is on the blocked list (JBC_BLOCKED_SITES).`);
    this.current = page;
    return new PlaywrightDriver(this, page);
  }

  checkUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs can be opened.');
    if (isBlocked(this.config.settings, url)) throw new Error(`${u.hostname} is on the blocked list (JBC_BLOCKED_SITES).`);
    return u.href;
  }

  provider() {
    // A key added to config.env while Claude is running counts from the next call.
    if (!keySet(this.config.settings)) this.config.settings = loadConfig().settings;
    const s = this.config.settings;
    if (!keySet(s)) throw new Error(`No key for Jev. Put OPENROUTER_API_KEY=... (or JBC_API_KEY=jbc_... for credits) in ~/.jev-browser-control/config.env and retry.`);
    return makeProvider(s, { settingsName: '~/.jev-browser-control/config.env' });
  }

  async brief(driver) {
    return { tabId: driver.tabId, page: await driver.observe({ viewportOnly: true, max: 80, textChars: 1500 }) };
  }

  describe() {
    const s = this.config.settings;
    return {
      provider: s.provider, key_set: keySet(s), jev_model: s.jevModel, text_model: s.textModel,
      limits: { max_steps: s.maxSteps, max_seconds: s.maxSeconds, max_cost_usd: s.maxCostUsd },
      confirm_irreversible: s.confirmIrreversible, input_mode: 'playwright',
    };
  }

  // Same method names and result shapes as the extension, so the MCP tools format them alike.
  async handle(method, params = {}, { onEvent } = {}) {
    switch (method) {
      case 'status': {
        if (!keySet(this.config.settings)) this.config.settings = loadConfig().settings;
        const context = await this.ensure();
        const page = await this.page();
        return {
          mode: 'browser', version: this.version, settings: this.describe(),
          browser: { executable: this.config.browser.chromePath || this.config.browser.channel, profile: this.config.browser.profileDir, headless: this.config.browser.headless, tabs: context.pages().length },
          current_tab: { tabId: this.idOf(page), url: page.url(), title: await page.title().catch(() => '') },
          running_tasks: [...this.tasks.values()].map((t) => ({ goal: t.goal, tabId: t.tabId, source: 'claude' })),
        };
      }
      case 'tabs.list': {
        const context = await this.ensure();
        const cur = await this.page();
        return Promise.all(context.pages().map(async (p) => ({ tabId: this.idOf(p), active: p === cur, current: p === cur, title: await p.title().catch(() => ''), url: p.url() })));
      }
      case 'tabs.select': {
        const page = await this.page(params.tabId);
        this.current = page;
        await page.bringToFront().catch(() => {});
        return { tabId: this.idOf(page), url: page.url(), title: await page.title() };
      }
      case 'tabs.close': {
        const page = await this.page(params.tabId);
        await page.close();
        return { closed: params.tabId };
      }
      case 'navigate': {
        const url = this.checkUrl(params.url);
        const context = await this.ensure();
        if (params.newTab) {
          const page = await context.newPage();
          this.current = page;
        }
        const d = await this.driver({ tabId: params.newTab ? undefined : params.tabId });
        await d.navigate(url);
        return this.brief(d);
      }
      case 'snapshot': {
        const d = await this.driver(params);
        return { tabId: d.tabId, page: await d.observe({ viewportOnly: !params.full, max: params.full ? 500 : 240, textChars: params.full ? 12000 : 6000 }) };
      }
      case 'click': {
        const d = await this.driver(params);
        const r = await d.click(Number(params.ref));
        await d.settle({ kind: 'click', ref: Number(params.ref) });
        return { ...r, ...(await this.brief(d)) };
      }
      case 'type': {
        const d = await this.driver(params);
        const r = await d.fill(Number(params.ref), String(params.text ?? ''));
        await d.settle({ kind: 'fill', ref: Number(params.ref) });
        if (params.submit) { await d.pressKey('Enter'); await d.settle({ kind: 'enter' }); }
        return { ...r, ...(await this.brief(d)) };
      }
      case 'select': {
        const d = await this.driver(params);
        const r = await d.select(Number(params.ref), { label: params.option, value: params.value });
        await d.settle({ kind: 'select' });
        return { ...r, ...(await this.brief(d)) };
      }
      case 'key': {
        const d = await this.driver(params);
        const r = await d.pressKey(params.key, params.ref ? Number(params.ref) : undefined);
        await d.settle({ kind: 'key' });
        return { ...r, ...(await this.brief(d)) };
      }
      case 'scroll': {
        const d = await this.driver(params);
        await d.scroll(params.direction || 'down', params.amount);
        return this.brief(d);
      }
      case 'history': {
        const d = await this.driver(params);
        if (params.direction === 'forward') await d.forward();
        else await d.back();
        return this.brief(d);
      }
      case 'wait': {
        const d = await this.driver(params);
        const until = Date.now() + Math.min(30, Number(params.seconds) || 5) * 1000;
        if (!params.text) { await sleep(until - Date.now()); return this.brief(d); }
        while (Date.now() < until) {
          const r = await d.read({ format: 'text', limit: 200000 }).catch(() => null);
          if (r?.content?.toLowerCase().includes(String(params.text).toLowerCase())) return { found: true, ...(await this.brief(d)) };
          await sleep(250);
        }
        return { found: false, ...(await this.brief(d)) };
      }
      case 'read': {
        const d = await this.driver(params);
        return d.read({ format: params.format || 'markdown', offset: params.offset || 0, limit: Math.min(params.limit || 20000, 100000) });
      }
      case 'screenshot': {
        const d = await this.driver(params);
        return d.screenshot({ quality: params.quality || 70 });
      }
      case 'jev.task': {
        if (!params.goal || !String(params.goal).trim()) throw new Error('Give Jev a goal.');
        const provider = this.provider();
        const context = await this.ensure();
        if (params.newTab) {
          if (!params.url) throw new Error('newTab needs a url.');
          this.current = await context.newPage();
        }
        const d = await this.driver({ tabId: params.newTab ? undefined : params.tabId });
        if (params.url && d.page.url() !== params.url) await d.navigate(this.checkUrl(params.url));
        const id = randomUUID();
        const abort = new AbortController();
        this.tasks.set(id, { abort, goal: params.goal, tabId: d.tabId });
        const s = this.config.settings;
        try {
          return await runTask({
            goal: params.goal, details: params.details, driver: d, provider, signal: abort.signal,
            onEvent, allowIrreversible: !!params.allowIrreversible,
            settings: { ...s, maxSteps: params.maxSteps || s.maxSteps, maxSeconds: params.maxSeconds || s.maxSeconds },
          });
        } finally {
          this.tasks.delete(id);
          this.current = d.page; // the task may have moved to a new tab
        }
      }
      case 'jev.find': {
        const d = await this.driver(params);
        return findElement({ description: params.description, driver: d, provider: this.provider(), settings: this.config.settings });
      }
      case 'jev.check': {
        const d = await this.driver(params);
        return checkPage({ statement: params.statement, driver: d, provider: this.provider(), settings: this.config.settings });
      }
      case 'jev.stop': {
        for (const t of this.tasks.values()) t.abort.abort();
        return { stopped: this.tasks.size };
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  }

  async close() {
    const c = this.context;
    this.context = null;
    await c?.close().catch(() => {});
  }
}
