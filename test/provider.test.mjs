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
