#!/usr/bin/env node
// Installs Jev Browser Control for Claude Code and/or OpenAI Codex on this computer:
//   - registers the MCP server as "jev-browser" (Claude Code: user scope; Codex: ~/.codex/config.toml)
//   - copies the jev-browser skill (agents/skills/jev-browser) to ~/.claude/skills and ~/.codex/skills
//   - copies the Claude Code subagent (agents/claude-code/jev-browser.md) to ~/.claude/agents
//
//   node scripts/install-agents.mjs              both, whichever is installed
//   node scripts/install-agents.mjs --claude     only Claude Code
//   node scripts/install-agents.mjs --codex      only Codex
//   node scripts/install-agents.mjs --npx        run the server from the published tarball instead of this clone
//   node scripts/install-agents.mjs --extension  drive your everyday Chrome through the extension instead of the
//                                                Chrome window the server opens itself (browser mode, the default)
//   node scripts/install-agents.mjs --uninstall  remove everything this script added
//   add --dry-run to print the steps without changing anything
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const uninstall = args.has('--uninstall');
const only = args.has('--claude') || args.has('--codex');
const NAME = 'jev-browser';
const TARBALL = 'https://jevbrowsercontrol.com/downloads/jev-browser-control-mcp-0.4.0.tgz';
const extensionMode = args.has('--extension');
// Homebrew's versioned Cellar path breaks on the next Node update; prefer its stable opt/ link.
function stableNode() {
  const m = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  const opt = m && `${m[1]}/opt/${m[2]}/bin/node`;
  return opt && existsSync(opt) ? opt : process.execPath;
}
const server = args.has('--npx') ? ['npx', '-y', TARBALL] : [stableNode(), join(ROOT, 'mcp', 'server.mjs')];
const envFlags = (flag) => (extensionMode ? [flag, 'JBC_MODE=extension'] : []);

function which(cmd, fallbacks = []) {
  try { return execFileSync('/usr/bin/env', ['which', cmd], { encoding: 'utf8' }).trim() || null; } catch {}
  return fallbacks.find((f) => existsSync(f)) || null;
}
function run(bin, argv, { ignore = false } = {}) {
  console.log(`  $ ${[bin, ...argv].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (dry) return;
  try { execFileSync(bin, argv, { stdio: ['ignore', 'ignore', ignore ? 'ignore' : 'inherit'] }); } catch (err) { if (!ignore) throw err; }
}
function copy(from, to) {
  console.log(`  copy ${from.replace(ROOT + '/', '')} -> ${to}`);
  if (dry) return;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
function remove(path) {
  if (!existsSync(path)) return;
  console.log(`  remove ${path}`);
  if (!dry) rmSync(path, { recursive: true, force: true });
}

const home = homedir();
const CONFIG_DIR = join(home, '.jev-browser-control');
const CONFIG = join(CONFIG_DIR, 'config.env');
const claude = which('claude', [join(home, '.local/bin/claude')]);
const codex = which('codex', ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex']);
const doClaude = (only ? args.has('--claude') : true) && (claude || existsSync(join(home, '.claude')));
const doCodex = (only ? args.has('--codex') : true) && (codex || existsSync(join(home, '.codex')));
if (!doClaude && !doCodex) {
  console.log('Neither Claude Code nor Codex was found.');
  process.exit(1);
}

// Browser mode runs Chrome through Playwright, which a clone needs installed once.
if (!uninstall && !extensionMode && !args.has('--npx') && !existsSync(join(ROOT, 'mcp/node_modules/playwright-core'))) {
  console.log('MCP server: installing its one dependency (playwright-core)');
  run('npm', ['install', '--omit=dev', '--prefix', join(ROOT, 'mcp')]);
}
if (!uninstall && !extensionMode && !existsSync(CONFIG)) {
  console.log(`  write ${CONFIG}`);
  if (!dry) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG, [
      '# Jev Browser Control, browser mode (the MCP server opens its own Chrome).',
      '# Put one key here: your own OpenRouter key, or a jbc_ key for jevbrowsercontrol.com credits.',
      '# OPENROUTER_API_KEY=sk-or-v1-...',
      '# JBC_API_KEY=jbc_...',
      '# JBC_HEADLESS=1              no visible window',
      '# JBC_BLOCKED_SITES=bank.com  sites the browser may not act on',
      '',
    ].join('\n'), { mode: 0o600 });
  }
}

if (doClaude) {
  console.log(uninstall ? 'Claude Code: removing' : 'Claude Code: installing');
  if (claude) run(claude, ['mcp', 'remove', '-s', 'user', NAME], { ignore: true });
  if (uninstall) {
    remove(join(home, '.claude/agents/jev-browser.md'));
    remove(join(home, '.claude/skills/jev-browser'));
  } else {
    if (claude) run(claude, ['mcp', 'add', '-s', 'user', ...envFlags('-e'), NAME, '--', ...server]);
    else console.log(`  claude CLI not found; add the MCP server yourself: claude mcp add -s user ${envFlags('-e').join(' ')} ${NAME} -- ${server.join(' ')}`);
    copy(join(ROOT, 'agents/claude-code/jev-browser.md'), join(home, '.claude/agents/jev-browser.md'));
    copy(join(ROOT, 'agents/skills/jev-browser'), join(home, '.claude/skills/jev-browser'));
  }
}

if (doCodex) {
  console.log(uninstall ? 'Codex: removing' : 'Codex: installing');
  if (codex) run(codex, ['mcp', 'remove', NAME], { ignore: true });
  if (uninstall) {
    remove(join(home, '.codex/skills/jev-browser'));
  } else {
    if (codex) run(codex, ['mcp', 'add', NAME, ...envFlags('--env'), '--', ...server]);
    else console.log(`  codex CLI not found; add to ~/.codex/config.toml:\n  [mcp_servers.${NAME}]\n  command = "${server[0]}"\n  args = ${JSON.stringify(server.slice(1))}${extensionMode ? '\n  env = { JBC_MODE = "extension" }' : ''}`);
    copy(join(ROOT, 'agents/skills/jev-browser'), join(home, '.codex/skills/jev-browser'));
  }
}

const next = extensionMode
  ? 'Restart Claude Code / Codex, keep Chrome open with the extension, and ask: "check the browser status".'
  : `Put your key in ${CONFIG} if it is not there yet, restart Claude Code / Codex and ask: "check the browser status". A Chrome window opens on first use; sign in to sites there once and the logins stay.`;
console.log(dry ? '\nDry run: nothing changed.' : uninstall ? '\nRemoved.' : `\nDone. ${next}`);
