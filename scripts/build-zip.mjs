// Builds the release files into dist/:
//   jev-browser-control-extension-<version>.zip      service edition, served by jevbrowsercontrol.com
//                                                   (and for the Chrome Web Store): credits only
//   oss/jev-browser-control-extension-<version>.zip  open-source edition, for GitHub releases:
//                                                   credits, your own OpenRouter key, or a custom endpoint
//   jev-browser-control-mcp-<version>.tgz            MCP server (npx -y <url-to-this-file>, or npm publish)
//   npm run zip
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
const mcpVersion = JSON.parse(readFileSync('mcp/package.json', 'utf8')).version;
mkdirSync('dist/oss', { recursive: true });

function zipEdition(edition, out) {
  const dir = join(mkdtempSync(join(tmpdir(), 'jbc-build-')), 'extension');
  cpSync('extension', dir, { recursive: true });
  const file = join(dir, 'lib/edition.js');
  const src = readFileSync(file, 'utf8');
  if (!src.includes("EDITION = 'open-source'")) throw new Error('lib/edition.js has an unexpected shape');
  writeFileSync(file, src.replace("EDITION = 'open-source'", `EDITION = '${edition}'`));
  rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', resolve(out), '.', '-x', '.*', '-x', '*/.*'], { cwd: dir, stdio: 'inherit' });
}
zipEdition('service', `dist/jev-browser-control-extension-${version}.zip`);
zipEdition('open-source', `dist/oss/jev-browser-control-extension-${version}.zip`);

copyFileSync('LICENSE', 'mcp/LICENSE');
execFileSync('npm', ['pack', '--pack-destination', '../dist'], { cwd: 'mcp', stdio: ['ignore', 'ignore', 'inherit'] });
if (!existsSync(`dist/jev-browser-control-mcp-${mcpVersion}.tgz`)) throw new Error('npm pack produced no tarball');
console.log(`built extension ${version} (service + open-source editions) and MCP server ${mcpVersion}`);
