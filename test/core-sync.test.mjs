import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CORE, expected } from '../scripts/sync-core.mjs';

test('mcp/lib/core is an exact copy of extension/lib (run scripts/sync-core.mjs)', () => {
  for (const name of CORE) assert.equal(readFileSync(`mcp/lib/core/${name}`, 'utf8'), expected(name), name);
});
