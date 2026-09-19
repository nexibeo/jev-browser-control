// Every setting, its default, and how it is stored (chrome.storage.local: keys never sync to other devices).
export const DEFAULTS = {
  // Where Jev runs: 'cloud' (Jev Browser Control credits), 'openrouter' (your own key) or 'custom'.
  provider: 'cloud',
  cloudBase: 'https://jevbrowsercontrol.com',
  cloudKey: '',
  openrouterKey: '',
  customDecisionsUrl: 'https://api.typesafe.ai/v1/systemone',
  customChatUrl: 'https://openrouter.ai/api/v1/chat/completions',
  customKey: '',
  customChatKey: '',

  // Models. ~typesafe/jev-latest always points to the newest Jev (the tilde is required on OpenRouter).
  jevModel: '~typesafe/jev-latest',
  textModel: 'inception/mercury-2.5',

  // Limits per task.
  maxSteps: 30,
  maxSeconds: 120,
  maxCostUsd: 0.1,
  maxElements: 240,

  // Safety.
  confirmIrreversible: true, // ask before buy / pay / send / delete-type clicks
  blockedSites: '', // one host per line; Jev and Claude won't act there (e.g. mybank.com)

  // Input: 'debugger' sends trusted clicks and keys via the DevTools protocol (Chrome shows a banner while attached);
  // 'dom' uses synthetic events (no banner, but some sites ignore them).
  inputMode: 'debugger',

  // Claude bridge: the MCP server listens on 127.0.0.1:<bridgePort>; this extension connects to it.
  bridgeEnabled: true,
  bridgePort: 10522,
  groupTabs: true, // put tabs Claude opens in an orange "Jev" tab group

  // Remote control: remote AI apps (Grok Bot, ChatGPT, claude.ai) reach this browser through
  // jevbrowsercontrol.com/mcp. Off by default. Authenticated with remoteKey, or the credits key.
  remoteEnabled: false,
  remoteKey: '',
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS) clean[k] = v;
  await chrome.storage.local.set(clean);
  return loadSettings();
}

export function isBlocked(settings, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return String(settings.blockedSites || '')
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .some((b) => host === b || host.endsWith('.' + b));
}

// A short, key-free description for status displays.
export function describe(settings) {
  const keySet = settings.provider === 'cloud' ? !!settings.cloudKey : settings.provider === 'custom' ? !!settings.customKey : !!settings.openrouterKey;
  return {
    provider: settings.provider,
    key_set: keySet,
    jev_model: settings.jevModel,
    text_model: settings.textModel,
    limits: { max_steps: settings.maxSteps, max_seconds: settings.maxSeconds, max_cost_usd: settings.maxCostUsd },
    confirm_irreversible: settings.confirmIrreversible,
    input_mode: settings.inputMode,
    remote_enabled: !!settings.remoteEnabled,
  };
}

export function relayEndpoint(settings) {
  const key = settings.remoteKey || settings.cloudKey;
  if (!settings.remoteEnabled || !key) return null;
  const base = String(settings.cloudBase || DEFAULTS.cloudBase).replace(/\/+$/, '').replace(/^http/, 'ws');
  return { url: `${base}/api/relay`, protocols: ['jbc.v1', `key.${key}`] };
}
