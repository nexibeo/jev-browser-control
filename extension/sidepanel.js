const $ = (id) => document.getElementById(id);
const port = chrome.runtime.connect({ name: 'panel' });
let running = null; // taskId shown in the log
let confirmId = null;

const OP_LABEL = { CLICK: 'CLICK', TYPE_TEXT: 'TYPE', SELECT: 'SELECT', PRESS_ENTER: 'ENTER', SCROLL_DOWN: 'SCROLL', SCROLL_UP: 'SCROLL', BACK: 'BACK', WAIT: 'WAIT', DONE: 'DONE', BLOCKED: 'BLOCKED' };
const STATUS = {
  done: ['Done', 'ok'],
  done_unconfirmed: ['Done, but unconfirmed', 'warn'],
  blocked: ['Blocked', 'bad'],
  stuck: ['Stuck', 'bad'],
  budget: ['Stopped at a limit', 'warn'],
  stopped: ['Stopped', 'warn'],
  needs_confirmation: ['Waiting for your OK', 'warn'],
  needs_input: ['Needs a value', 'warn'],
};

function setClaude(connected) {
  const el = $('claude');
  el.querySelector('.dot').className = 'dot' + (connected ? ' on' : '');
  el.querySelector('span:last-child').textContent = connected ? 'Claude connected' : 'Claude not connected';
}

function setRemote({ enabled, connected }) {
  const el = $('remote');
  el.hidden = !enabled;
  el.querySelector('.dot').className = 'dot' + (connected ? ' on' : ' warn');
  el.querySelector('span:last-child').textContent = connected ? 'Remote on' : 'Remote: connecting';
}

function setProvider(s) {
  const el = $('provider');
  const name = s.provider === 'cloud' ? 'Credits' : s.provider === 'custom' ? 'Custom' : 'OpenRouter';
  el.querySelector('.dot').className = 'dot' + (s.key_set ? ' on' : ' warn');
  el.querySelector('span:last-child').textContent = s.key_set ? name : `${name}: no key`;
  const hint = $('keyhint');
  hint.hidden = s.key_set;
  hint.innerHTML = s.key_set ? '' : 'Add an API key in <a href="options.html" target="_blank">Settings</a> first.';
}

function setRunning(on) {
  $('run').hidden = on;
  $('stop').hidden = !on;
  $('goal').disabled = on;
}

function li(html, cls = '') {
  const el = document.createElement('li');
  el.className = cls;
  el.innerHTML = html;
  $('log').appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
  $('empty').hidden = true;
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (n) => (typeof n === 'number' ? Math.round(n * 100) + '%' : '');
const usd = (n) => (n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(3));

function onEvent(e) {
  if (e.type === 'start') {
    running = e.taskId;
    $('log').innerHTML = '';
    $('result').hidden = true;
    setRunning(true);
    li(`<span class="n">▸</span><span class="what">${esc(e.goal)}<span class="typed">${esc(e.title || e.url)}${e.source === 'claude' ? ' · from Claude' : e.source === 'remote' ? ' · from a remote app' : ''}</span></span><span></span>`);
    return;
  }
  if (e.taskId !== running) return;
  if (e.type === 'action') {
    const op = OP_LABEL[e.operation] || e.operation;
    const failed = String(e.outcome).startsWith('failed');
    li(`<span class="n">${e.step}</span><span class="what"><span class="op">${op}</span>${esc(e.action)}${e.text ? `<span class="typed">“${esc(e.text)}”</span>` : ''}${failed ? `<span class="typed">${esc(e.outcome)}</span>` : ''}</span><span class="meta">${pct(e.target_confidence ?? e.confidence)}<br>${e.decide_ms} ms</span>`, failed ? 'failed' : '');
    $('cost').textContent = usd(e.cost || 0);
  } else if (e.type === 'stale') {
    li(`<span class="n">↻</span><span class="what">Page changed before acting; looking again</span><span></span>`, 'stale');
  } else if (e.type === 'end') {
    setRunning(false);
    running = null;
    const [title, cls] = STATUS[e.status] || [e.status, 'warn'];
    const r = $('result');
    r.className = 'card result ' + cls;
    r.innerHTML = `<h3>${esc(title)}</h3>${e.note ? `<p>${esc(e.note)}</p>` : ''}<p class="stats">${e.steps.length} actions · ${(e.elapsed_ms / 1000).toFixed(1)} s · ${usd(e.cost_usd || 0)}${e.credits_remaining_usd !== undefined ? ` · $${e.credits_remaining_usd.toFixed(2)} credits left` : ''}</p>`;
    r.hidden = false;
    $('cost').textContent = usd(e.cost_usd || 0);
  }
}

port.onMessage.addListener((msg) => {
  if (msg.type === 'state') {
    setClaude(msg.bridge.connected);
    setProvider(msg.settings);
    if (msg.relay) setRemote(msg.relay);
    if (msg.running.length) { running = msg.running[0].taskId; setRunning(true); }
  } else if (msg.type === 'bridge') setClaude(msg.connected);
  else if (msg.type === 'relay') setRemote(msg);
  else if (msg.type === 'settings') setProvider(msg.settings);
  else if (msg.type === 'event') onEvent(msg.event);
  else if (msg.type === 'idle') { if (!running || msg.taskId === running) setRunning(false); }
  else if (msg.type === 'error') {
    setRunning(false);
    const r = $('result');
    r.className = 'card result bad';
    r.innerHTML = `<h3>Couldn't run</h3><p>${esc(msg.message)}</p>`;
    r.hidden = false;
  } else if (msg.type === 'confirm-expired') {
    if (msg.id === confirmId) { $('confirm').hidden = true; confirmId = null; }
  } else if (msg.type === 'confirm') {
    confirmId = msg.id;
    let host = msg.url;
    try { host = new URL(msg.url).hostname; } catch {}
    const who = msg.source === 'remote' ? 'A remote app wants' : 'Jev wants';
    $('confirm-text').textContent = `${who} to click “${msg.label}” on ${host}. This may be hard to undo.`;
    $('confirm').hidden = false;
    $('allow').focus();
  }
});

$('task').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const goal = $('goal').value.trim();
  if (!goal) return;
  setRunning(true);
  port.postMessage({ type: 'run', goal, details: $('details').value.trim() || undefined });
});
$('goal').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) $('task').requestSubmit();
});
$('stop').addEventListener('click', () => port.postMessage({ type: 'stop', taskId: running }));
const answer = (ok) => { port.postMessage({ type: 'confirm', id: confirmId, ok }); $('confirm').hidden = true; confirmId = null; };
$('allow').addEventListener('click', () => answer(true));
$('deny').addEventListener('click', () => answer(false));
$('claude').addEventListener('click', () => port.postMessage({ type: 'reconnect' }));

port.postMessage({ type: 'getState' });
