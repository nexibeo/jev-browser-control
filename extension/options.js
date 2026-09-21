import { DEFAULTS, loadSettings, saveSettings, SERVICE } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS).filter((k) => k !== 'provider');
let savedTimer;

function showProvider(p) {
  for (const el of document.querySelectorAll('[data-for]')) el.hidden = el.dataset.for !== p;
  // The service edition (from jevbrowsercontrol.com) runs on credits only.
  if (SERVICE) {
    for (const el of document.querySelectorAll('[data-oss]')) el.hidden = true;
    for (const el of document.querySelectorAll('[data-service]')) el.hidden = false;
  }
}

function read() {
  const patch = { provider: SERVICE ? 'cloud' : document.querySelector('input[name=provider]:checked')?.value || 'cloud' };
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') patch[k] = el.checked;
    else if (el.type === 'number') patch[k] = el.value === '' ? DEFAULTS[k] : Number(el.value);
    else patch[k] = el.value.trim();
  }
  return patch;
}

async function save() {
  await saveSettings(read());
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1500);
}

async function init() {
  const s = await loadSettings();
  for (const r of document.querySelectorAll('input[name=provider]')) r.checked = r.value === s.provider;
  showProvider(s.provider);
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k] ?? '';
  }
  document.addEventListener('change', (ev) => {
    if (ev.target.name === 'provider') showProvider(ev.target.value);
    if (ev.target.closest('main')) save();
  });
  document.addEventListener('input', (ev) => {
    if (ev.target.matches('input[type=text],input[type=password],input[type=url],textarea')) { clearTimeout(savedTimer); savedTimer = setTimeout(save, 500); }
  });
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      const t = b.textContent;
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = t), 1200);
    });
  }
  $('test').addEventListener('click', async () => {
    await save();
    const out = $('testResult');
    out.className = 'hint';
    out.textContent = 'Testing…';
    const r = await chrome.runtime.sendMessage({ type: 'testProvider' });
    if (r?.ok) {
      out.className = 'hint ok';
      out.textContent = `Works: ${r.model} answered in ${r.ms} ms` + (r.balance !== null && r.balance !== undefined ? ` · $${Number(r.balance).toFixed(2)} credits left` : '');
    } else {
      out.className = 'hint err';
      out.textContent = r?.error || 'No answer from the extension.';
    }
  });
  pollBridge();
}

// The side panel port also reports the bridge; here a short-lived port asks once a second.
function pollBridge() {
  const port = chrome.runtime.connect({ name: 'options' });
  const set = (on) => {
    const el = $('bridgeStatus');
    el.querySelector('.dot').className = 'dot' + (on ? ' on' : '');
    el.querySelector('span:last-child').textContent = on ? 'Claude connected' : 'Claude not running';
  };
  const setRelay = ({ enabled, connected }) => {
    const el = $('relayStatus');
    el.querySelector('.dot').className = 'dot' + (connected ? ' on' : enabled ? ' warn' : '');
    el.querySelector('span:last-child').textContent = connected ? 'connected' : enabled ? 'connecting…' : 'off';
  };
  port.onMessage.addListener((m) => {
    if (m.type === 'state') { set(m.bridge.connected); if (m.relay) setRelay(m.relay); }
    if (m.type === 'bridge') set(m.connected);
    if (m.type === 'relay') setRelay(m);
  });
  port.postMessage({ type: 'getState' });
}

init();
