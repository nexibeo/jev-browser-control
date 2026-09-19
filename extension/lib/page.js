// Code that runs inside the web page (the extension's isolated world).
// chrome.scripting serializes pageOp for every call, so it must stay self-contained:
// no imports and no references to anything outside the function body.
//
// The element table, visibility rules, accessible names and freshness guards are a
// JavaScript port of Jev Ultrafast's snapshot.js (MIT, (c) 2026 Browser Use), extended
// with open shadow roots, card context for links, and full-page reading.

export function pageOp(op, arg = {}) {
  const J = (window.__jbc ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!J.ids.has(e)) J.ids.set(e, J.next++);
    const id = J.ids.get(e);
    J.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of J.nodes) if (!e.isConnected) J.nodes.delete(id);

  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
  const clean = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const safe = (e) => !['password', 'file', 'hidden'].includes(String(e.type || '').toLowerCase());
  const visible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') &&
    (e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : e.getClientRects().length > 0);

  // Every element under root, including inside open shadow roots.
  const deepAll = (selector, root = document) => {
    const out = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) out.push(...deepAll(selector, host.shadowRoot));
    return out;
  };
  const deepHit = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const composedContains = (outer, inner) => {
    for (let n = inner; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  };

  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const root = e.getRootNode?.() || document;
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => name(root.getElementById?.(id) || document.getElementById(id), seen))
      .filter(Boolean)
      .join(' ');
    return (
      referenced ||
      e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
      e.getAttribute('alt') ||
      (e.tagName === 'INPUT'
        ? ''
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3 ? n.textContent : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '',
            )
            .join(' ')
            .trim()) ||
      e.getAttribute('title') ||
      e.getAttribute('placeholder') ||
      ''
    );
  };

  const ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'treeitem'];
  const SELECTOR = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],' +
    ROLES.map((r) => `[role="${r}"]`).join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (ROLES.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      const t = String(e.type || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (t === 'range') return 'slider';
      if (['text', 'email', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week'].includes(t)) return 'textbox';
    }
    return null;
  };
  const editable = (e, r) =>
    !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
    (['textbox', 'searchbox', 'spinbutton'].includes(r) || (r === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
  // Date-like inputs take a formatted value, not typed text (Chrome splits them into segments).
  const FORMATTED = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'];
  const inputType = (e) => (e.tagName === 'INPUT' ? String(e.type || 'text').toLowerCase() : '');
  const valueOf = (e, r) =>
    e.tagName === 'SELECT' ? [...e.selectedOptions].map((o) => o.label).join(', ')
      : ['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(inputType(e)) ? ''
      : 'value' in e && e.tagName !== 'BUTTON' && e.tagName !== 'LI' ? String(e.value ?? '')
      : e.isContentEditable || r === 'combobox' ? clean(e.innerText, 300) : '';

  const formState = () =>
    deepAll('input,textarea,select').filter(safe)
      .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly]);
  const pageKey = () => hash(JSON.stringify([performance.timeOrigin, location.href, scrollX, scrollY, innerWidth, innerHeight, formState()]));
  const guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return hash(JSON.stringify([identity(e), role(e), name(e), e.value ?? null, e.checked ?? null, e.selectedIndex ?? null,
      e.readOnly ?? null, e.matches(':disabled'), e.getAttribute('aria-disabled'), e.getAttribute('aria-expanded'),
      e.getAttribute('aria-checked'), e.getAttribute('aria-selected'), e.getAttribute('href'), scope?.innerText?.slice(0, 6000) || '']));
  };
  // The text of the enclosing card or row helps judge a bare link title ("Read more", a product name).
  const context = (e, label) => {
    let best = '';
    for (let up = e.parentElement, i = 0; up && i < 5; up = up.parentElement, i++) {
      const t = clean(up.innerText, 1000);
      if (t.length >= 400) break;
      if (t.length > label.length + 20) best = t.replace(label, '').trim();
    }
    return best.slice(0, 140);
  };

  const viewportText = (limit) => {
    const words = [], range = document.createRange();
    let length = 0;
    const walk = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && length < limit) {
        const value = node.textContent.trim(), parent = node.parentElement;
        if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
          words.push(value);
          length += value.length + 1;
        }
      }
      for (const host of root.querySelectorAll?.('*') || []) if (host.shadowRoot && length < limit) walk(host.shadowRoot);
    };
    walk(document.body);
    return words.join('\n').slice(0, limit);
  };

  if (op === 'observe') {
    if (!document.body) return null;
    const { viewportOnly = true, max = 240, textChars = 6000, contexts = true } = arg;
    const elements = [];
    let omitted = 0;
    for (const e of deepAll(SELECTOR)) {
      if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, rname = role(e);
      if (!rname || r.width <= 0 || r.height <= 0) continue;
      const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      if (viewportOnly && !inView) continue;
      if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
      if (elements.length >= max) { omitted++; continue; }
      const label = clean(name(e), 120) || rname;
      const el = { ref: identity(e), role: rname, label, inView };
      const value = valueOf(e, rname);
      if (value && value !== label) el.value = clean(value, 200);
      for (const key of ['checked', 'selected', 'expanded']) {
        const v = e.getAttribute('aria-' + key);
        if (v !== null) el[key] = v;
      }
      if (['checkbox', 'radio'].includes(e.type)) el.checked = String(e.checked);
      if (e.tagName === 'A' && e.href) {
        try { const u = new URL(e.href, location.href); el.href = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
        if (el.href) el.href = el.href.slice(0, 100);
      }
      if (e.tagName === 'SELECT') {
        el.options = [...e.options].slice(0, 60).map((o, i) => ({ i, label: clean(o.label, 60), value: o.value, selected: o.selected, disabled: o.disabled || !!o.closest('optgroup[disabled]') }));
      } else if (editable(e, rname)) {
        el.editable = true;
        const t = inputType(e);
        if (t && !['text', 'search'].includes(t)) el.inputType = t;
      }
      if (contexts && rname === 'link' && inView && label.length < 60) {
        const c = context(e, label);
        if (c) el.context = c;
      }
      el.guard = guard(e);
      elements.push(el);
    }
    // A row and the link inside it often share one label (search suggestions, cards). Offer only the
    // inner element, so Jev's probability isn't split between two identical options.
    const byRef = new Map(elements.map((el) => [el.ref, el]));
    const drop = new Set();
    for (const el of elements) {
      const node = J.nodes.get(el.ref);
      for (let up = node?.parentElement, i = 0; up && i < 6; up = up.parentElement, i++) {
        const outer = byRef.get(J.ids.get(up));
        if (outer && outer.label === el.label && !outer.editable && !outer.options) drop.add(outer.ref);
      }
    }
    if (drop.size) for (let i = elements.length - 1; i >= 0; i--) if (drop.has(elements[i].ref)) elements.splice(i, 1);
    const height = document.documentElement.scrollHeight;
    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(scrollY), height, canDown: scrollY + innerHeight < height - 2, canUp: scrollY > 0 },
      canGoBack: window.navigation?.canGoBack ?? history.length > 1,
      text: viewportText(textChars),
      elements,
      omitted,
      key: pageKey(),
      focused: document.activeElement && J.ids.get(document.activeElement) || null,
    };
  }

  // Check the target still is what was observed, bring it into view, and return its centre.
  if (op === 'prepare') {
    const e = J.nodes.get(arg.ref);
    if (!e?.isConnected) return { error: 'stale', reason: 'element is gone; observe again' };
    if (arg.key && arg.key !== pageKey() && arg.strict) return { error: 'stale', reason: 'page changed' };
    if (arg.guard && arg.guard !== guard(e)) return { error: 'stale', reason: 'element changed since it was observed' };
    if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return { error: 'disabled', reason: 'element is disabled' };
    if (arg.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return { error: 'readonly', reason: 'field is read-only' };
    let r = e.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = e.getBoundingClientRect();
    }
    if (!visible(e) || !r.width || !r.height) return { error: 'hidden', reason: 'element is not visible' };
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { error: 'offscreen', reason: 'element is outside the viewport' };
    const hit = deepHit(x, y);
    if (hit && !composedContains(e, hit) && !composedContains(hit, e)) {
      return { error: 'covered', reason: `covered by ${hit.tagName.toLowerCase()} "${clean(name(hit) || hit.innerText, 40)}"` };
    }
    return { x, y, role: role(e), label: clean(name(e), 120), tag: e.tagName, editable: editable(e, role(e)), contentEditable: e.isContentEditable, formatted: FORMATTED.includes(inputType(e)) };
  }

  if (op === 'select') {
    const e = J.nodes.get(arg.ref);
    if (!e?.isConnected || e.tagName !== 'SELECT') return { error: 'stale', reason: 'dropdown is gone' };
    const o = [...e.options].find((o) => (arg.value !== undefined ? o.value === arg.value : clean(o.label, 60).toLowerCase() === String(arg.label).toLowerCase()));
    if (!o || o.disabled || o.closest('optgroup[disabled]')) return { error: 'option', reason: 'option not available' };
    e.value = o.value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: clean(o.label, 60) };
  }

  // Input without the debugger: synthetic events. Works on most sites; React inputs need the native setter.
  if (op === 'domClick') {
    const e = J.nodes.get(arg.ref);
    if (!e?.isConnected) return { error: 'stale' };
    e.focus?.({ preventScroll: true });
    const r = e.getBoundingClientRect(), opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    e.dispatchEvent(new PointerEvent('pointerdown', opts));
    e.dispatchEvent(new MouseEvent('mousedown', opts));
    e.dispatchEvent(new PointerEvent('pointerup', opts));
    e.dispatchEvent(new MouseEvent('mouseup', opts));
    e.click();
    return { ok: true };
  }
  if (op === 'domFill') {
    const e = J.nodes.get(arg.ref);
    if (!e?.isConnected) return { error: 'stale' };
    e.focus?.({ preventScroll: true });
    if (e.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, arg.text);
    } else {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, arg.text);
      e.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: arg.text }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, value: e.value ?? e.innerText };
  }
  if (op === 'domKey') {
    const e = (arg.ref && J.nodes.get(arg.ref)) || document.activeElement || document.body;
    const opts = { key: arg.key, code: arg.code, bubbles: true, cancelable: true, composed: true };
    const down = e.dispatchEvent(new KeyboardEvent('keydown', opts));
    e.dispatchEvent(new KeyboardEvent('keyup', opts));
    // Synthetic Enter does not submit forms by itself.
    if (down && arg.key === 'Enter' && e.form && e.tagName === 'INPUT') e.form.requestSubmit?.();
    return { ok: true };
  }
  if (op === 'scroll') {
    scrollBy({ top: arg.dy || 0, left: 0, behavior: 'instant' });
    return { y: Math.round(scrollY) };
  }

  // After an action: wait two animation frames (50 ms cap), or up to 200 ms for an autocomplete to open.
  if (op === 'settle') {
    const field = arg.ref && J.nodes.get(arg.ref);
    const autocomplete = arg.kind === 'fill' && (field?.getAttribute('role') === 'combobox' || field?.getAttribute('aria-autocomplete') || field?.getAttribute('list'));
    return new Promise((resolve) => {
      let frames = 0, stopped = false;
      const finish = () => { stopped = true; resolve(true); };
      setTimeout(finish, autocomplete ? 200 : 50);
      const ready = () => {
        if (stopped) return;
        const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
        const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
        const options = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]);
        if (++frames >= 2 && (!autocomplete || options.some((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight && visible(e); }))) finish();
        else requestAnimationFrame(ready);
      };
      requestAnimationFrame(ready);
    });
  }

  if (op === 'fingerprint') return pageKey() + ':' + hash(viewportText(3000));

  // Whole-page reading for Claude: text or light markdown, paged by character offset.
  if (op === 'read') {
    const { format = 'markdown', offset = 0, limit = 20000 } = arg;
    let out = '';
    if (format === 'text') out = document.body.innerText;
    else if (format === 'links') {
      out = deepAll('a[href]').filter(visible).map((a) => `- [${clean(name(a), 100) || a.href}](${a.href})`).join('\n');
    } else {
      const lines = [];
      const skip = 'script,style,noscript,template,svg,nav[aria-hidden="true"]';
      const walk = (n) => {
        if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' '); if (t.trim()) lines.push(t); return; }
        if (n.nodeType !== 1 || n.matches(skip) || !visible(n)) return;
        const tag = n.tagName;
        if (/^H[1-6]$/.test(tag)) { lines.push(`\n\n${'#'.repeat(+tag[1])} ${clean(n.innerText, 300)}\n\n`); return; }
        if (tag === 'A' && n.href) { lines.push(`[${clean(n.innerText, 200) || clean(name(n), 100)}](${n.href})`); return; }
        if (tag === 'IMG') { const alt = clean(n.alt, 100); if (alt) lines.push(`![${alt}]`); return; }
        if (tag === 'LI') lines.push('\n- ');
        if (tag === 'BR') lines.push('\n');
        if (['P', 'DIV', 'SECTION', 'ARTICLE', 'TR', 'UL', 'OL', 'TABLE', 'FORM', 'HEADER', 'FOOTER', 'MAIN'].includes(tag)) lines.push('\n');
        if (tag === 'TD' || tag === 'TH') lines.push(' | ');
        for (const c of n.shadowRoot ? n.shadowRoot.childNodes : n.childNodes) walk(c);
        if (['P', 'DIV', 'SECTION', 'ARTICLE', 'TR', 'TABLE'].includes(tag)) lines.push('\n');
      };
      walk(document.body);
      out = lines.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
    }
    return { url: location.href, title: document.title, total: out.length, offset, content: out.slice(offset, offset + limit) };
  }

  return { error: 'unknown op ' + op };
}
