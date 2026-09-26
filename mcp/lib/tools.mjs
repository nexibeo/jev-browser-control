// The MCP tools Claude sees, and how each result is turned into text for Claude.

const tabId = { type: 'integer', description: 'Tab to act on. Omit to use the tab Claude used last (or the active tab).' };
const ref = { type: 'integer', description: 'Element number from the latest browser_snapshot, shown as [n].' };

export const TOOLS = [
  {
    name: 'browser_status',
    title: 'Browser status',
    description: 'Check that the browser is ready, which tab is current, and how Jev is configured (key, models, limits). Call this first, and whenever another tool reports a problem.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'status',
  },
  {
    name: 'browser_tabs',
    title: 'List or switch tabs',
    description: 'List all open tabs in the user\'s Chrome, or select or close one. The selected tab becomes the current tab for later calls.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'select', 'close'], default: 'list' },
        tabId: { type: 'integer', description: 'Required for select and close.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'browser_navigate',
    title: 'Open a URL',
    description: 'Open a URL in the current tab, or in a new tab with newTab: true. Returns the page\'s visible elements.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http or https URL' }, newTab: { type: 'boolean', default: false }, tabId },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
    method: 'navigate',
    timeoutMs: 45_000,
  },
  {
    name: 'browser_snapshot',
    title: 'Read the page as numbered elements',
    description: 'The current page as numbered interactive elements ([n] role "label" value) plus its visible text. Use the numbers as `ref` in browser_click, browser_type and browser_select. By default only elements inside the visible screen are listed; full: true lists the whole page (elements below are scrolled into view when you act on them).',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', default: false }, tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'snapshot',
  },
  {
    name: 'browser_click',
    title: 'Click an element',
    description: 'Click element [ref] from the latest snapshot with a real mouse click. Returns the updated visible elements. Before clicking anything that buys, pays, sends, posts or deletes, confirm with the user.',
    inputSchema: { type: 'object', properties: { ref, tabId }, required: ['ref'], additionalProperties: false },
    annotations: { destructiveHint: true, openWorldHint: true },
    method: 'click',
  },
  {
    name: 'browser_type',
    title: 'Type into a field',
    description: 'Replace the contents of text field [ref] with `text`. submit: true presses Enter afterwards. Password fields are never listed and can\'t be typed into.',
    inputSchema: {
      type: 'object',
      properties: { ref, text: { type: 'string' }, submit: { type: 'boolean', default: false }, tabId },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    method: 'type',
  },
  {
    name: 'browser_select',
    title: 'Choose a dropdown option',
    description: 'Choose `option` (the visible label) in dropdown [ref].',
    inputSchema: { type: 'object', properties: { ref, option: { type: 'string' }, tabId }, required: ['ref', 'option'], additionalProperties: false },
    annotations: { destructiveHint: true },
    method: 'select',
  },
  {
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Press a key or combination in the page: Enter, Tab, Escape, ArrowDown, PageDown, Backspace, a letter, or combos like "Control+A" / "Meta+A". With ref, the element is focused first.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, ref, tabId }, required: ['key'], additionalProperties: false },
    annotations: { destructiveHint: true },
    method: 'key',
  },
  {
    name: 'browser_scroll',
    title: 'Scroll',
    description: 'Scroll the page (or the scroll area under the middle of the page) up or down by about one screen, or by `amount` pixels.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'], default: 'down' }, amount: { type: 'integer' }, tabId }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    method: 'scroll',
  },
  {
    name: 'browser_back',
    title: 'Back or forward',
    description: 'Go back in the tab\'s history, or forward with forward: true.',
    inputSchema: { type: 'object', properties: { forward: { type: 'boolean', default: false }, tabId }, additionalProperties: false },
    annotations: { destructiveHint: false },
    method: 'history',
  },
  {
    name: 'browser_wait',
    title: 'Wait',
    description: 'Wait until `text` appears on the page (up to `seconds`, max 30), or just wait `seconds`.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, seconds: { type: 'number', default: 5 }, tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'wait',
    timeoutMs: 40_000,
  },
  {
    name: 'browser_read',
    title: 'Read the whole page',
    description: 'The whole page as markdown (headings, links, lists), plain text, or a list of links. Long pages are paged: pass offset to continue.',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['markdown', 'text', 'links'], default: 'markdown' }, offset: { type: 'integer', default: 0 }, limit: { type: 'integer', default: 20000 }, tabId },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    method: 'read',
  },
  {
    name: 'browser_screenshot',
    title: 'Screenshot',
    description: 'A JPEG screenshot of the visible part of the page. Use it to check layout, images or anything the text snapshot misses.',
    inputSchema: { type: 'object', properties: { quality: { type: 'integer', minimum: 20, maximum: 95, default: 70 }, tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'screenshot',
  },
  {
    name: 'browser_hover',
    title: 'Hover over an element',
    description: 'Move the mouse onto element [ref] without clicking, to open menus that appear on hover (reaction pickers, navigation menus, tooltips). Returns the updated visible elements, including what the hover revealed.',
    inputSchema: { type: 'object', properties: { ref, tabId }, required: ['ref'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
    method: 'hover',
  },
  {
    name: 'browser_clipboard',
    title: 'Read what the page copied',
    description: 'The text the page last copied, for example after a "Copy link" menu item. Only text copied on the current page since it loaded.',
    inputSchema: { type: 'object', properties: { tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'clipboard',
    browserOnly: true,
  },
  {
    name: 'browser_record',
    title: 'Record the browser screen',
    description: 'Start or stop a screen recording of the browser (the current tab, following tab switches). stop saves an MP4 on this computer and returns its path.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop'] }, name: { type: 'string', description: 'Optional name for the file (start only).' } },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    method: 'record',
    browserOnly: true,
    timeoutMs: 180_000,
  },
  {
    name: 'jev_task',
    title: 'Hand a browser task to Jev',
    description:
      'Delegate a multi-step browser task to Jev, TypeSafe\'s fast decision model. Jev reads the page as numbered elements and picks one action per step ' +
      '(about 0.5 s and a fraction of a cent per step) until the goal is met. Good for navigating, searching, setting filters and filling forms. ' +
      'Put every value that must be typed (names, dates, addresses, search terms) in the goal or in `details`; the text helper never invents personal data. ' +
      'Returns the status (done, done_unconfirmed, blocked, stuck, budget, needs_confirmation, needs_input), each step, the cost and the final page\'s visible text. ' +
      'Clicks that buy, pay, send, post or delete stop with needs_confirmation unless allowIrreversible is true; only set it after the user agreed. ' +
      'Jev can pick a confident near-miss: check the final page before telling the user it worked.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What to achieve, in plain English, with every requirement (e.g. "Search for one-way flights Zurich to London on 20 Oct and sort by price").' },
        details: { type: 'string', description: 'Facts Jev may type: names, dates, addresses, quantities. Never passwords.' },
        url: { type: 'string', description: 'Open this URL first.' },
        newTab: { type: 'boolean', default: false, description: 'Open url in a new tab.' },
        maxSteps: { type: 'integer', minimum: 1, maximum: 200 },
        maxSeconds: { type: 'integer', minimum: 5, maximum: 1800 },
        allowIrreversible: { type: 'boolean', default: false },
        tabId,
      },
      required: ['goal'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    method: 'jev.task',
    timeoutMs: 35 * 60_000,
  },
  {
    name: 'jev_find',
    title: 'Find an element with Jev',
    description: 'Ask Jev which visible element best matches a description ("the Add to cart button for the blue shirt"). Returns the top candidates with refs and probabilities; nothing is clicked. One fast, cheap call.',
    inputSchema: { type: 'object', properties: { description: { type: 'string' }, tabId }, required: ['description'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'jev.find',
  },
  {
    name: 'jev_check',
    title: 'Check a statement about the page',
    description: 'Ask Jev how likely a statement about the current page is true ("The cart contains 2 items", "The user is logged in"). Returns a probability from 0 to 1. Useful to verify a result cheaply.',
    inputSchema: { type: 'object', properties: { statement: { type: 'string' }, tabId }, required: ['statement'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    method: 'jev.check',
  },
  {
    name: 'jev_stop',
    title: 'Stop Jev',
    description: 'Stop every running Jev task in the browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { destructiveHint: false },
    method: 'jev.stop',
  },
];

// ---------- formatting ----------

const q = (s) => JSON.stringify(String(s ?? ''));

export function formatPage(page, { tabId: tab, heading } = {}) {
  if (!page) return 'The page is not ready yet. Try browser_snapshot again.';
  const lines = [];
  if (heading) lines.push(heading);
  lines.push(`Tab ${tab ?? page.tabId ?? '?'} · ${page.title || '(no title)'}`, page.url);
  if (page.scroll) {
    const more = [page.scroll.canUp && 'more above', page.scroll.canDown && 'more below'].filter(Boolean).join(', ');
    lines.push(`Scroll: ${page.scroll.y} of ${page.scroll.height} px${more ? ` (${more})` : ''}`);
  }
  lines.push('', 'Elements (use the number as ref):');
  for (const e of page.elements || []) {
    let s = `[${e.ref}] ${e.role}${e.inputType ? ` (${e.inputType})` : ''} ${q(e.label)}`;
    if (e.options) {
      const cur = e.options.filter((o) => o.selected).map((o) => o.label).join(', ');
      s += ` = ${q(cur)} options: ${e.options.filter((o) => !o.disabled).slice(0, 25).map((o) => o.label).join(' | ')}${e.options.length > 25 ? ' | …' : ''}`;
    } else if (e.value !== undefined) s += ` value=${q(e.value)}`;
    if (e.checked !== undefined) s += e.checked === 'true' ? ' (checked)' : ' (not checked)';
    if (e.expanded !== undefined) s += e.expanded === 'true' ? ' (expanded)' : ' (collapsed)';
    if (e.selected === 'true') s += ' (selected)';
    if (e.disabled) s += ' (disabled)';
    if (e.publishes) s += ' (posts the typed text)';
    if (e.href) s += ` → ${e.href}`;
    if (e.context) s += ` — ${e.context}`;
    if (e.inView === false) s += ' (below/above the screen)';
    lines.push(s);
  }
  if (!page.elements?.length) lines.push('(no interactive elements in view)');
  if (page.omitted) lines.push(`… ${page.omitted} more elements not listed (scroll, or browser_snapshot with full: true)`);
  if (page.text) lines.push('', 'Visible text:', page.text);
  return lines.join('\n');
}

const STATUS_TEXT = {
  done: 'done',
  done_unconfirmed: 'done_unconfirmed: Jev chose DONE but its own check disagrees; verify the page',
  blocked: 'blocked',
  stuck: 'stuck',
  budget: 'budget: stopped at a limit',
  stopped: 'stopped',
  needs_confirmation: 'needs_confirmation',
  needs_input: 'needs_input',
};

export function formatTask(r) {
  const lines = [`Status: ${STATUS_TEXT[r.status] || r.status}`];
  if (r.note) lines.push(r.note);
  if (r.pending) lines.push(`Pending: [${r.pending.ref}] ${q(r.pending.label)} on ${r.pending.url}. Ask the user; then call browser_click with ref ${r.pending.ref}, or rerun with allowIrreversible: true.`);
  const cost = typeof r.cost_usd === 'number' ? `$${r.cost_usd.toFixed(5)}` : '';
  lines.push(`Steps: ${r.steps.length} actions, ${r.decisions} Jev calls, ${(r.elapsed_ms / 1000).toFixed(1)} s, ${cost}${r.credits_remaining_usd !== undefined ? `, $${r.credits_remaining_usd.toFixed(2)} credits left` : ''}${r.model ? ` (${r.model})` : ''}`);
  for (const s of r.steps) {
    const conf = s.target_confidence ?? s.confidence;
    lines.push(`${s.step}. ${s.operation} ${q(s.action)}${s.text !== undefined ? ` ← ${q(s.text)}` : ''} (${conf})${s.outcome !== 'done' ? ` ${s.outcome}` : ''}${s.page_changed ? '' : ' · no visible change'}`);
  }
  lines.push('', `Final page: ${r.final.title} — ${r.final.url}`, 'Visible text:', r.final.text || '(none)');
  return lines.join('\n');
}

export function formatResult(tool, result) {
  switch (tool) {
    case 'browser_status':
      if (result.mode === 'browser') return [
        `Browser: ready (Jev Browser Control ${result.version}, ${result.browser.executable}${result.browser.headless ? ', headless' : ', visible window'}, ${result.browser.tabs} tab(s))`,
        `Profile: ${result.browser.profile} (logins made in this window are kept)`,
        result.current_tab ? `Current tab: ${result.current_tab.tabId} · ${result.current_tab.title || '(no title)'} — ${result.current_tab.url}` : 'Current tab: none',
        `Jev: ${result.settings.provider === 'cloud' ? 'jevbrowsercontrol.com credits' : 'own OpenRouter key'}${result.settings.key_set ? '' : ' (NO KEY SET: jev_* tools will fail until the user adds OPENROUTER_API_KEY or JBC_API_KEY to ~/.jev-browser-control/config.env)'}`,
        `Models: ${result.settings.jev_model} + ${result.settings.text_model}`,
        `Limits per task: ${result.settings.limits.max_steps} actions, ${result.settings.limits.max_seconds} s, $${result.settings.limits.max_cost_usd}`,
        `Stops before irreversible clicks: ${result.settings.confirm_irreversible ? 'yes' : 'no'}`,
        result.running_tasks.length ? `Running: ${result.running_tasks.map((t) => `${q(t.goal)} in tab ${t.tabId}`).join('; ')}` : 'No Jev task running.',
      ].join('\n');
      return [
        `Extension: connected (v${result.version}, id ${result.extensionId})`,
        result.current_tab ? `Current tab: ${result.current_tab.tabId} · ${result.current_tab.title} — ${result.current_tab.url}` : 'Current tab: none',
        `Jev provider: ${result.settings.provider}${result.settings.key_set ? '' : ' (NO API KEY SET: jev_* tools will fail until the user adds one in the extension settings)'}`,
        `Models: ${result.settings.jev_model} + ${result.settings.text_model}`,
        `Limits per task: ${result.settings.limits.max_steps} actions, ${result.settings.limits.max_seconds} s, $${result.settings.limits.max_cost_usd}`,
        `Ask before irreversible clicks: ${result.settings.confirm_irreversible ? 'yes' : 'no'}; input: ${result.settings.input_mode}`,
        result.running_tasks.length ? `Running: ${result.running_tasks.map((t) => `${q(t.goal)} in tab ${t.tabId}`).join('; ')}` : 'No Jev task running.',
      ].join('\n');
    case 'browser_tabs':
      if (Array.isArray(result)) return result.map((t) => `${t.current ? '*' : ' '} ${t.tabId}${t.active ? ' (active)' : ''} · ${t.title} — ${t.url}`).join('\n') + '\n\n* = current tab for browser tools';
      return JSON.stringify(result);
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_scroll':
    case 'browser_back':
      return formatPage(result.page, { tabId: result.tabId });
    case 'browser_click':
      return formatPage(result.page, { tabId: result.tabId, heading: `Clicked ${q(result.clicked)}.\n` });
    case 'browser_type':
      return formatPage(result.page, { tabId: result.tabId, heading: `Typed ${q(result.typed)} into ${q(result.into)}.\n` });
    case 'browser_select':
      return formatPage(result.page, { tabId: result.tabId, heading: `Selected ${q(result.selected)}.\n` });
    case 'browser_hover':
      return formatPage(result.page, { tabId: result.tabId, heading: `Hovering over ${q(result.hovered)}.\n` });
    case 'browser_clipboard':
      return result.text == null
        ? `Nothing was copied on this page yet (${result.url}). Click the page's copy button or menu item first.`
        : `Copied text: ${result.text}\n(copied ${result.copied_at} on ${result.url})`;
    case 'browser_record':
      if (result.recording) return `Recording the browser. Call browser_record with action "stop" to save it.\nFolder: ${result.dir}`;
      return result.saved
        ? `Recording saved: ${result.saved}\n${result.seconds} s, ${result.frames} frames.`
        : `Recording stopped without a video: ${result.note}\nFolder: ${result.dir}`;
    case 'browser_press_key':
      return formatPage(result.page, { tabId: result.tabId, heading: `Pressed ${result.pressed}.\n` });
    case 'browser_wait':
      return formatPage(result.page, { tabId: result.tabId, heading: result.found === undefined ? 'Waited.\n' : result.found ? 'The text appeared.\n' : 'The text did not appear in time.\n' });
    case 'browser_read': {
      const end = result.offset + result.content.length;
      return `${result.title} — ${result.url}\nCharacters ${result.offset}-${end} of ${result.total}${end < result.total ? ` (call again with offset ${end} for more)` : ''}\n\n${result.content}`;
    }
    case 'jev_task':
      return formatTask(result);
    case 'jev_find':
      return [
        result.choice?.none ? 'Jev: no visible element matches.' : `Best match: [${result.choice.ref}] ${result.choice.role} ${q(result.choice.label)} (p=${result.choice.p}, confidence ${result.confidence})`,
        'Candidates:',
        ...result.candidates.map((c) => (c.none ? `- none of them (p=${c.p})` : `- [${c.ref}] ${c.role} ${q(c.label)} p=${c.p}`)),
        `Cost: $${result.cost_usd} (${result.model})`,
      ].join('\n');
    case 'jev_check':
      return `Probability the statement is true: ${result.probability_true}\nPage: ${result.title} — ${result.url}\nCost: $${result.cost_usd} (${result.model})`;
    default:
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}
