import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'jbc-cfg-'));
process.env.JBC_HOME = home;
for (const k of ['OPENROUTER_API_KEY', 'JBC_API_KEY', 'JBC_PROVIDER', 'JBC_MAX_STEPS', 'JBC_BLOCKED_SITES', 'JBC_HEADLESS']) delete process.env[k];
const { loadConfig, keySet, isBlocked } = await import('../mcp/lib/config.mjs');
const { LocalBrowser } = await import('../mcp/lib/local-browser.mjs');

test('config.env is read, the environment wins, and a jbc_ key picks credits', () => {
  let c = loadConfig();
  assert.equal(keySet(c.settings), false);
  assert.equal(c.settings.maxSeconds, 120);
  writeFileSync(join(home, 'config.env'), '# comment\nexport JBC_API_KEY="jbc_test"\nJBC_MAX_STEPS=12\nJBC_BLOCKED_SITES=*.bank.com, https://pay.example/\nJBC_HEADLESS=1\n');
  process.env.JBC_MAX_STEPS = '7';
  c = loadConfig();
  delete process.env.JBC_MAX_STEPS;
  assert.equal(c.settings.provider, 'cloud');
  assert.equal(c.settings.cloudKey, 'jbc_test');
  assert.equal(c.settings.maxSteps, 7);
  assert.equal(c.browser.headless, true);
  assert.equal(c.browser.profileDir, join(home, 'chrome-profile'));
  assert.ok(isBlocked(c.settings, 'https://www.bank.com/login'));
  assert.ok(isBlocked(c.settings, 'https://pay.example/checkout'));
  assert.ok(!isBlocked(c.settings, 'https://notbank.com/'));
});

test('a key added to config.env while running counts from the next call', () => {
  writeFileSync(join(home, 'config.env'), '');
  const lb = new LocalBrowser(loadConfig(), { version: 't' });
  assert.throws(() => lb.provider(), /No key for Jev/);
  writeFileSync(join(home, 'config.env'), 'OPENROUTER_API_KEY=sk-or-v1-test\n');
  assert.equal(lb.provider().label, 'Your OpenRouter key');
});
