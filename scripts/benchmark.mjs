// Jev vs. general LLMs on the same browser tasks, in the same loop.
// Only the decision-maker changes: Jev answers the step questions natively; an LLM gets the
// identical state and questions as JSON and answers in JSON. Page reading, typing (the same
// small text model for everyone), stop gates and success checks are identical.
//
// This is a lower bound for LLM agents: Claude Code or Codex driving a browser also resend their
// system prompt, tool definitions and the whole conversation on every step.
//
//   CHROME_PATH=... node --env-file=.env scripts/benchmark.mjs [--models jev,anthropic/claude-sonnet-5] [--tasks wiki,form,hn]
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pageOp } from '../extension/lib/page.js';
import { runTask, StaleError, fingerprint } from '../extension/lib/agent.js';
import { makeProvider } from '../extension/lib/provider.js';

const KEY = process.env.OPENROUTER_API_KEY;
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const MODELS = arg('--models', 'jev,anthropic/claude-sonnet-5,anthropic/claude-opus-5,openai/gpt-6-astra,openai/gpt-5.3-codex').split(',');
const TASK_IDS = arg('--tasks', 'wiki,form,hn').split(',');
const IS_MAC = process.platform === 'darwin';

const TASKS = {
  wiki: {
    goal: 'Search Wikipedia for "Ristretto" and open the Ristretto article.',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    check: async (page) => /\/wiki\/Ristretto$/.test(new URL(page.url()).pathname),
  },
  form: {
    goal: 'Fill in the pizza order form: customer name Ada Lovelace, telephone 555-0100, email ada@example.org, a large pizza with bacon and onion, delivery at 19:30. Do not submit the form.',
    url: 'https://httpbin.org/forms/post',
    check: async (page) => page.url().includes('/forms/post') && page.evaluate(() => {
      const f = document.forms[0];
      const v = (n) => f.elements[n]?.value;
      const checked = (name, value) => !!f.querySelector(`[name="${name}"][value="${value}"]:checked`);
      return v('custname') === 'Ada Lovelace' && v('custtel') === '555-0100' && v('custemail') === 'ada@example.org' &&
        checked('size', 'large') && checked('topping', 'bacon') && checked('topping', 'onion') && v('delivery') === '19:30';
    }),
  },
  hn: {
    goal: 'Open the comments page of the top story on Hacker News.',
    url: 'https://news.ycombinator.com/',
    before: async (page) => page.evaluate(() => document.querySelector('tr.athing')?.id),
    check: async (page, topId) => page.url().includes(`item?id=${topId}`),
  },
};

// ---------- the browser, driven by Playwright with the extension's own page code ----------
class PlaywrightDriver {
  constructor(page) { this.page = page; this.tabId = 1; }
  async run(op, arg) {
    for (let i = 0; ; i++) {
      try {
        const r = await this.page.evaluate(`(${pageOp.toString()})(${JSON.stringify(op)}, ${JSON.stringify(arg ?? {})})`);
        if (r !== null || op !== 'observe') return r;
      } catch (err) {
        if (i >= 10) throw err;
      }
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await this.page.waitForTimeout(100);
    }
  }
  async observe(opts = {}) {
    const page = await this.run('observe', { viewportOnly: true, max: 240, textChars: 6000, ...opts });
    page.tabId = 1;
    page.fingerprint = fingerprint(page);
    return page;
  }
  async prepare(ref, extra) {
    const p = await this.run('prepare', { ref, ...extra });
    if (!p || p.error === 'stale') throw new StaleError(p?.reason || 'navigating');
    if (p.error) throw new Error(p.reason);
    return p;
  }
  async click(ref, o = {}) { const p = await this.prepare(ref, { kind: 'click', ...o }); await this.page.mouse.click(p.x, p.y); }
  async fill(ref, text, o = {}) {
    const p = await this.prepare(ref, { kind: 'fill', ...o });
    if (p.formatted) return this.run('domFill', { ref, text });
    await this.page.mouse.click(p.x, p.y);
    await this.page.keyboard.press(IS_MAC ? 'Meta+A' : 'Control+A');
    await this.page.keyboard.insertText(text);
  }
  async select(ref, option) { const r = await this.run('select', { ref, value: option.value }); if (r?.error) throw new Error(r.reason); }
  async pressKey(key) { await this.page.keyboard.press(key); }
  async scroll(dir) { await this.page.mouse.wheel(0, dir === 'up' ? -700 : 700); await this.page.waitForTimeout(120); }
  async back() { await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
  async wait(ms) { await this.page.waitForTimeout(ms); }
  async settle(action = {}) {
    await this.run('settle', { ref: action.ref, kind: action.kind }).catch(() => {});
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  }
  async read(opts) { return this.run('read', opts); }
}

// ---------- an LLM answering Jev's questions ----------
const SYSTEM = `You decide the next step of a browser agent. You get {state, questions} as JSON.
For every question of type "choice", pick exactly one key of its "criteria". For every question of type "noul", give the probability (0 to 1) that its statement is true.
Follow each question's instructions and rules. Reply with JSON only, no prose:
{"answers": {"<question name>": {"choice": "<key>"} or {"noul": <number>}, ...}}`;

function llmProvider(model, textProvider) {
  let cost = 0, calls = 0, inTokens = 0, outTokens = 0;
  async function call(body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if ([429, 502, 503, 529].includes(res.status) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      const json = await res.json();
      if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
      cost += Number(json.usage?.cost) || 0;
      inTokens += json.usage?.prompt_tokens || 0;
      outTokens += json.usage?.completion_tokens || 0;
      calls++;
      return json;
    }
  }
  const reasoning = model.startsWith('anthropic/') ? { enabled: false } : { effort: 'low' };
  return {
    get cost() { return cost + textProvider.cost; },
    balance: null,
    stats: () => ({ decision_calls: calls, input_tokens: inTokens, output_tokens: outTokens }),
    async decide(body) {
      const json = await call({
        model, max_tokens: 2000, temperature: 0, reasoning, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ state: body.state, questions: body.questions }) }],
      });
      const raw = String(json.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/)?.[0];
      let a;
      try { a = JSON.parse(raw).answers || {}; } catch { a = {}; }
      // Jev's answer shape: a one-hot distribution for choices, a probability for nouls.
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === 'noul') { answers[name] = { noul: Math.min(1, Math.max(0, Number(a[name]?.noul ?? a[name]) || 0)) }; continue; }
        const keys = Object.keys(q.criteria);
        const pick = String(a[name]?.choice ?? a[name] ?? '');
        const choice = keys.includes(pick) ? pick : keys[0]; // an invalid pick becomes the first option (counted below)
        if (!keys.includes(pick)) answers.__invalid = (answers.__invalid || 0) + 1;
        answers[name] = { choice, confidence: 1, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])) };
      }
      delete answers.__invalid;
      return { model: json.model, answers };
    },
    text: (ctx, opts) => textProvider.text(ctx, opts),
  };
}

// ---------- run ----------
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: !process.env.HEADED });
const rows = [];
for (const taskId of TASK_IDS) {
  const task = TASKS[taskId];
  for (const model of MODELS) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto(task.url, { waitUntil: 'domcontentloaded' });
    const before = task.before ? await task.before(page) : null;
    const base = { provider: 'openrouter', openrouterKey: KEY, jevModel: '~typesafe/jev-latest', textModel: 'inception/mercury-2.5' };
    const textProvider = makeProvider(base);
    const provider = model === 'jev' ? makeProvider(base) : llmProvider(model, textProvider);
    const settings = { ...base, maxSteps: 15, maxSeconds: 150, maxCostUsd: 1.5, confirmIrreversible: true };
    const t0 = Date.now();
    let result, error = null;
    try {
      result = await runTask({ goal: task.goal, driver: new PlaywrightDriver(page), provider, settings });
    } catch (err) {
      error = err.message.slice(0, 200);
    }
    await page.waitForTimeout(300);
    const passed = !error && (await task.check(page, before).catch(() => false));
    const row = {
      task: taskId, model: model === 'jev' ? 'jev (~typesafe/jev-latest)' : model, passed,
      status: result?.status || 'error', actions: result?.steps.length ?? 0, decisions: result?.decisions ?? 0,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), cost_usd: Number(provider.cost.toFixed(5)),
      ...(provider.stats ? provider.stats() : {}), ...(error ? { error } : {}),
      steps: (result?.steps || []).map((s) => `${s.operation} ${s.action}${s.text ? ` <- "${s.text}"` : ''}${s.page_changed ? '' : ' (no change)'}`),
    };
    rows.push(row);
    console.log(`${passed ? '✓' : '✗'} ${taskId.padEnd(5)} ${row.model.padEnd(30)} ${String(row.seconds).padStart(6)} s  $${row.cost_usd.toFixed(5)}  ${row.decisions} decisions  ${row.status}${error ? ' ' + error : ''}`);
    await ctx.close();
  }
}
await browser.close();

// Totals per model over the tasks it passed and over all tasks.
const by = {};
for (const r of rows) {
  const m = (by[r.model] ||= { model: r.model, passed: 0, runs: 0, seconds: 0, cost_usd: 0 });
  m.runs++; m.passed += r.passed ? 1 : 0; m.seconds += r.seconds; m.cost_usd += r.cost_usd;
}
console.log('\nmodel                           passed   total time   total cost');
for (const m of Object.values(by)) console.log(`${m.model.padEnd(30)} ${m.passed}/${m.runs}      ${m.seconds.toFixed(1).padStart(6)} s   $${m.cost_usd.toFixed(4)}`);
mkdirSync('results', { recursive: true });
const file = `results/benchmark-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), note: 'Same loop and page snapshot for every model; LLMs answer the same questions as JSON. Lower bound for LLM agents, which also resend conversation and tool definitions every step.', rows, totals: Object.values(by) }, null, 2));
console.log(`\nwrote ${file}`);
