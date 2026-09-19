// Builds the release files into dist/:
//   jev-browser-control-extension-<version>.zip   (load unpacked, or upload to the Chrome Web Store)
//   jev-browser-control-mcp-<version>.tgz         (npx -y <url-to-this-file>, or npm publish)
//   npm run zip
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';

const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
const mcpVersion = JSON.parse(readFileSync('mcp/package.json', 'utf8')).version;
if (version !== mcpVersion) throw new Error(`extension ${version} and mcp ${mcpVersion} versions differ`);
mkdirSync('dist', { recursive: true });
const zip = `dist/jev-browser-control-extension-${version}.zip`;
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', `../${zip}`, '.', '-x', '.*', '-x', '*/.*'], { cwd: 'extension', stdio: 'inherit' });
copyFileSync('LICENSE', 'mcp/LICENSE');
execFileSync('npm', ['pack', '--pack-destination', '../dist'], { cwd: 'mcp', stdio: 'inherit' });
if (!existsSync(`dist/jev-browser-control-mcp-${version}.tgz`)) throw new Error('npm pack produced no tarball');
console.log(`built ${zip} and dist/jev-browser-control-mcp-${version}.tgz`);
