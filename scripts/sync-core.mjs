// The browser agent's core (loop, questions, page code, model client) lives in extension/lib/,
// because a Chrome extension can only load files inside its own folder. The MCP server runs the
// same code in its own browser, so it ships identical copies in mcp/lib/core/.
//   node scripts/sync-core.mjs          copy extension/lib -> mcp/lib/core
// test/core-sync.test.mjs fails when the copies drift.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
export const CORE = ['agent.js', 'policy.js', 'page.js', 'provider.js'];
const HEADER = '// Copied from extension/lib by scripts/sync-core.mjs. Edit the original, then run the script.\n';
export const expected = (name) => HEADER + readFileSync(`extension/lib/${name}`, 'utf8');
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const name of CORE) writeFileSync(`mcp/lib/core/${name}`, expected(name));
  console.log(`synced ${CORE.join(', ')} -> mcp/lib/core/`);
}
