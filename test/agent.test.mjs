import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask, StaleError } from '../extension/lib/agent.js';

// A tiny fake site: a search box, a Search button, results with a "Buy" button.
function fakeSite() {
  const s = { query: '', searched: false, bought: false, url: 'https://shop.test/' };
  const els = () => {
    const list = [
      { ref: 1, role: 'searchbox', label: 'Search', editable: true, value: s.query, inView: true, guard: 'q' + s.query },
      { ref: 2, role: 'button', label: 'Go', inView: true, guard: 'go' },
    ];
    if (s.searched) list.push({ ref: 3, role: 'button', label: 'Buy now', inView: true, guard: 'buy' });
    return list;
  };
  const driver = {
    tabId: 7,
    calls: [],
    async observe() {
      return { url: s.url, title: s.searched ? 'Results' : 'Shop', text: s.bought ? 'Thanks for your order' : s.searched ? `Results for ${s.query}` : 'Welcome', scroll: { y: 0, height: 800, canDown: false, canUp: false }, canGoBack: false, elements: els(), key: 'k', tabId: 7 };
    },
    async click(ref) { this.calls.push(['click', ref]); if (ref === 2) { s.searched = true; s.url = 'https://shop.test/?q=' + s.query; } if (ref === 3) s.bought = true; },
    async fill(ref, text) { this.calls.push(['fill', ref, text]); s.query = text; },
    async select() {},
    async pressKey(k, ref) { this.calls.push(['key', k, ref]); s.searched = true; },
    async scroll() {},
    async back() {},
    async wait() {},
    async settle() {},
  };
  return { s, driver };
}

// A scripted Jev: a function from the request body to the operation and target keys.
function fakeProvider(script, { text = 'Dune' } = {}) {
  let cost = 0;
  const bodies = [];
  const dist = (ids, pick) => ({ choice: pick, confidence: 0.95, probabilities: Object.fromEntries(ids.map((k) => [k, k === pick ? 1 : 0])) });
  return {
    bodies,
    get cost() { return cost; },
    balance: null,
    async decide(body) {
      bodies.push(body);
      cost += 0.0001;
      const want = script(body, bodies.length);
      if (want.error) throw want.error;
      const answers = { operation: dist(Object.keys(body.questions.operation.criteria), want.op), goal_done: { noul: want.goal ?? 0.1 } };
      for (const [k, q] of Object.entries(body.questions)) {
        if (!k.endsWith('_target')) continue;
        const ids = Object.keys(q.criteria);
        answers[k] = dist(ids, want.target && ids.includes(want.target) ? want.target : ids[0]);
      }
      return { model: 'typesafe/jev-test', answers };
    },
    async text() { cost += 0.00001; return { text, model: 'tiny' }; },
  };
}

const settings = { maxSteps: 10, maxSeconds: 30, maxCostUsd: 1, confirmIrreversible: true, jevModel: 'm' };

test('type, press Enter, then DONE with a confirming watcher', async () => {
  const { driver } = fakeSite();
  const provider = fakeProvider((body, n) => (n === 1 ? { op: 'TYPE_TEXT', target: '1' } : n === 2 ? { op: 'PRESS_ENTER' } : { op: 'DONE', goal: 0.97 }));
  const events = [];
  const r = await runTask({ goal: 'Search for Dune', driver, provider, settings, onEvent: (e) => events.push(e.type) });
  assert.equal(r.status, 'done');
  assert.deepEqual(driver.calls, [['fill', 1, 'Dune'], ['key', 'Enter', 1]]);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].text, 'Dune');
  assert.ok(r.steps.every((s) => s.page_changed));
  assert.ok('PRESS_ENTER' in provider.bodies[1].questions.operation.criteria);
  assert.ok(!('PRESS_ENTER' in provider.bodies[0].questions.operation.criteria));
  assert.deepEqual(events.slice(0, 2), ['start', 'decision']);
  assert.equal(events.at(-1), 'end');
  assert.ok(r.cost_usd > 0);
});

test('DONE with a low goal_done is reported as unconfirmed', async () => {
  const { driver } = fakeSite();
  const r = await runTask({ goal: 'x', driver, provider: fakeProvider(() => ({ op: 'DONE', goal: 0.2 })), settings });
  assert.equal(r.status, 'done_unconfirmed');
});

test('irreversible click stops for confirmation unless allowed', async () => {
  const script = (body, n) => (n === 1 ? { op: 'TYPE_TEXT', target: '1' } : n === 2 ? { op: 'CLICK', target: '2' } : n === 3 ? { op: 'CLICK', target: '3' } : { op: 'DONE', goal: 0.9 });
  let { driver } = fakeSite();
  let r = await runTask({ goal: 'Buy Dune', driver, provider: fakeProvider(script), settings });
  assert.equal(r.status, 'needs_confirmation');
  assert.equal(r.pending.ref, 3);
  assert.ok(!driver.calls.some((c) => c[0] === 'click' && c[1] === 3));

  ({ driver } = fakeSite());
  let asked = null;
  r = await runTask({ goal: 'Buy Dune', driver, provider: fakeProvider(script), settings, confirm: async (x) => { asked = x.label; return true; } });
  assert.equal(asked, 'Buy now');
  assert.equal(r.status, 'done');
  assert.ok(driver.calls.some((c) => c[0] === 'click' && c[1] === 3));

  ({ driver } = fakeSite());
  r = await runTask({ goal: 'Buy Dune', driver, provider: fakeProvider(script), settings, allowIrreversible: true });
  assert.equal(r.status, 'done');
});

test('a missing value is skipped once, then stops with needs_input instead of guessing', async () => {
  const { driver } = fakeSite();
  const r = await runTask({ goal: 'Fill the form', driver, provider: fakeProvider(() => ({ op: 'TYPE_TEXT', target: '1' }), { text: null }), settings });
  assert.equal(r.status, 'needs_input');
  assert.equal(driver.calls.length, 0);
  assert.match(r.steps[0].outcome, /^skipped/);
});

test('an optional field without a value is skipped and the task goes on', async () => {
  const { driver } = fakeSite();
  const script = (b, n) => (n === 1 ? { op: 'TYPE_TEXT', target: '1' } : n === 2 ? { op: 'CLICK', target: '2' } : { op: 'DONE', goal: 0.9 });
  const r = await runTask({ goal: 'Just press Go', driver, provider: fakeProvider(script, { text: null }), settings });
  assert.equal(r.status, 'done');
  assert.deepEqual(driver.calls, [['click', 2]]);
});

test('three actions without a visible change end as stuck', async () => {
  const { driver } = fakeSite();
  driver.click = async () => {}; // clicks do nothing
  const r = await runTask({ goal: 'x', driver, provider: fakeProvider(() => ({ op: 'CLICK', target: '2' })), settings });
  assert.equal(r.status, 'stuck');
  assert.equal(r.steps.length, 3);
});

test('a stale page is observed again and re-decided without acting', async () => {
  const { driver } = fakeSite();
  let first = true;
  const click = driver.click.bind(driver);
  driver.click = async (ref, o) => { if (first) { first = false; throw new StaleError('element changed'); } return click(ref, o); };
  const script = (body, n) => (n <= 2 ? { op: 'CLICK', target: '2' } : { op: 'DONE', goal: 0.9 });
  const r = await runTask({ goal: 'x', driver, provider: fakeProvider(script), settings });
  assert.equal(r.status, 'done');
  assert.equal(r.decisions, 3);
  assert.equal(r.steps.length, 1);
});

test('max_tokens_exceeded shrinks the element list and retries', async () => {
  const { driver } = fakeSite();
  const err = Object.assign(new Error('max_tokens_exceeded'), { code: 'max_tokens_exceeded' });
  const r = await runTask({ goal: 'x', driver, provider: fakeProvider((b, n) => (n === 1 ? { error: err } : { op: 'DONE', goal: 0.9 })), settings: { ...settings, maxElements: 100 } });
  assert.equal(r.status, 'done');
});

test('budgets stop the run', async () => {
  const { driver } = fakeSite();
  const r = await runTask({ goal: 'x', driver, provider: fakeProvider(() => ({ op: 'WAIT' })), settings: { ...settings, maxSteps: 2 } });
  assert.equal(r.status, 'budget');
  assert.equal(r.steps.length, 2);
  const ac = new AbortController();
  ac.abort();
  const s = await runTask({ goal: 'x', driver, provider: fakeProvider(() => ({ op: 'WAIT' })), settings, signal: ac.signal });
  assert.equal(s.status, 'stopped');
});
