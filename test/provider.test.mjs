import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProvider } from '../extension/lib/provider.js';

const settings = { provider: 'openrouter', openrouterKey: 'sk-test', jevModel: '~typesafe/jev-latest' };
const okResponse = () => new Response(JSON.stringify({ answers: {}, usage: { cost: 0.0002 } }), { status: 200 });

test('a dropped connection is retried before the task fails', async () => {
  let calls = 0;
  const fetchImpl = async () => { if (++calls < 3) throw new TypeError('fetch failed'); return okResponse(); };
  const p = makeProvider(settings, { fetchImpl });
  await p.decide({ state: 's', questions: {} });
  assert.equal(calls, 3);
  assert.equal(p.cost, 0.0002);
});

test('a network error that persists is reported, with where to fix the key', async () => {
  const p = makeProvider(settings, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(p.decide({ state: 's', questions: {} }), (e) => e.code === 'network' && /Could not reach openrouter\.ai/.test(e.message));
  const bad = makeProvider(settings, { settingsName: 'config.env', fetchImpl: async () => new Response('{"error":{"message":"nope"}}', { status: 401 }) });
  await assert.rejects(bad.decide({ state: 's', questions: {} }), (e) => e.code === 'bad_key' && /in config\.env/.test(e.message));
});

test('credits customers are sent to the dashboard: no key, used up, key refused, and the balance', async () => {
  const cloud = { provider: 'cloud', cloudKey: 'jbc_test', cloudBase: 'https://jevbrowsercontrol.com' };
  const none = makeProvider({ ...cloud, cloudKey: '' }, { settingsName: 'the plugin settings' });
  await assert.rejects(none.decide({ state: 's', questions: {} }), (e) => e.code === 'no_key' && /jevbrowsercontrol\.com\/dashboard/.test(e.message) && /plugin settings/.test(e.message));
  const empty = makeProvider(cloud, { fetchImpl: async () => new Response('{"error":{"message":"Out of credits"}}', { status: 402 }) });
  await assert.rejects(empty.decide({ state: 's', questions: {} }), (e) => e.code === 'no_credits' && /credits are used up\. Add credits at https:\/\/jevbrowsercontrol\.com\/dashboard/.test(e.message));
  const refused = makeProvider(cloud, { fetchImpl: async () => new Response('{"error":{"message":"bad"}}', { status: 401 }) });
  await assert.rejects(refused.decide({ state: 's', questions: {} }), (e) => e.code === 'bad_key' && /dashboard/.test(e.message));
  let asked;
  const bal = makeProvider(cloud, { fetchImpl: async (url, init) => { asked = [url, init.headers.Authorization]; return new Response('{"balance_usd":4.2,"markup":5}'); } });
  assert.equal(await bal.balanceNow(), 4.2);
  assert.deepEqual(asked, ['https://jevbrowsercontrol.com/api/v1/balance', 'Bearer jbc_test']);
  assert.equal(await makeProvider(settings).balanceNow(), null);
});

test('task results and status remind the user to add credits when they run low', async () => {
  const { creditsNote, formatResult } = await import('../mcp/lib/tools.mjs');
  assert.equal(creditsNote(4.2), '');
  assert.match(creditsNote(0.42), /running low: \$0\.42 left\. Add credits at https:\/\/jevbrowsercontrol\.com\/dashboard/);
  assert.match(creditsNote(0), /used up/);
  const status = (settings) => formatResult('browser_status', { mode: 'browser', version: 't', browser: { executable: 'chrome', tabs: 1, profile: 'p' }, settings: { jev_model: 'j', text_model: 't', limits: { max_steps: 1, max_seconds: 1, max_cost_usd: 1 }, ...settings }, running_tasks: [] });
  assert.match(status({ provider: 'cloud', key_set: true, credits_usd: 12.5 }), /\$12\.50 left \(add credits at https:\/\/jevbrowsercontrol\.com\/dashboard\)/);
  assert.match(status({ provider: 'cloud', key_set: false, key_where: 'the plugin settings' }), /NO KEY SET.*jevbrowsercontrol\.com\/dashboard.*the plugin settings/);
});
