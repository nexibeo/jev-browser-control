// Settings for the MCP server's own browser (browser mode).
// Read from ~/.jev-browser-control/config.env (KEY=value lines), then an optional JBC_ENV_FILE,
// then the process environment, which wins. Keys never need to go into Claude's or Codex's config.
//
//   OPENROUTER_API_KEY   run Jev on your own OpenRouter key (open-source use)
//   JBC_API_KEY          or on jevbrowsercontrol.com credits (jbc_ key)
//   JBC_PROVIDER         openrouter | cloud (default: cloud when JBC_API_KEY is set, else openrouter)
//   JBC_JEV_MODEL, JBC_TEXT_MODEL, JBC_MAX_STEPS, JBC_MAX_SECONDS, JBC_MAX_COST_USD
//   JBC_CONFIRM_IRREVERSIBLE=0   let jev_task click buy/send/delete buttons without stopping
//   JBC_BLOCKED_SITES    comma-separated domains the browser may not act on
//   CHROME_PATH          a Chrome/Chromium binary; otherwise the installed Google Chrome is used
//   JBC_CHROME_CHANNEL   chrome (default), chrome-beta, msedge, chromium
//   JBC_HEADLESS=1       no visible window
//   JBC_PROFILE_DIR      browser profile, kept between sessions so logins stay (default ~/.jev-browser-control/chrome-profile)
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.JBC_HOME || join(homedir(), '.jev-browser-control');

function parseEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadConfig() {
  const file = { ...parseEnvFile(join(HOME, 'config.env')), ...parseEnvFile(process.env.JBC_ENV_FILE) };
  const env = { ...file, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')) };
  const num = (k, d) => (env[k] !== undefined && !Number.isNaN(Number(env[k])) ? Number(env[k]) : d);
  const provider = env.JBC_PROVIDER || (env.JBC_API_KEY ? 'cloud' : 'openrouter');
  return {
    settings: {
      provider,
      cloudBase: env.JBC_BASE || 'https://jevbrowsercontrol.com',
      cloudKey: env.JBC_API_KEY || '',
      openrouterKey: env.OPENROUTER_API_KEY || '',
      jevModel: env.JBC_JEV_MODEL || '~typesafe/jev-latest',
      textModel: env.JBC_TEXT_MODEL || 'inception/mercury-2.5',
      maxSteps: num('JBC_MAX_STEPS', 30),
      maxSeconds: num('JBC_MAX_SECONDS', 120),
      maxCostUsd: num('JBC_MAX_COST_USD', 0.1),
      maxElements: 240,
      confirmIrreversible: env.JBC_CONFIRM_IRREVERSIBLE !== '0',
      blockedSites: env.JBC_BLOCKED_SITES || '',
    },
    browser: {
      chromePath: env.CHROME_PATH || '',
      channel: env.JBC_CHROME_CHANNEL || 'chrome',
      headless: env.JBC_HEADLESS === '1',
      profileDir: env.JBC_PROFILE_DIR || join(HOME, 'chrome-profile'),
    },
    sources: Object.keys(file).length ? 'config.env' : 'environment',
  };
}

export function keySet(s) {
  return s.provider === 'cloud' ? !!s.cloudKey : !!s.openrouterKey;
}

export function isBlocked(settings, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return String(settings.blockedSites || '').split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .some((b) => host === b || host.endsWith('.' + b));
}
