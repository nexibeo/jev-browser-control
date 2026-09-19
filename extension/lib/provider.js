// Where Jev's decisions and the text helper's values come from.
//   cloud      — Jev Browser Control credits: one jbc_ key, billed per call (no OpenRouter account needed)
//   openrouter — your own OpenRouter key (free and open source; you pay OpenRouter directly)
//   custom     — any compatible endpoint, e.g. TypeSafe direct (https://api.typesafe.ai/v1/systemone)
import { TEXT_VALUE } from './policy.js';

export const OPENROUTER_DECISIONS = 'https://openrouter.ai/api/alpha/decisions';
export const OPENROUTER_CHAT = 'https://openrouter.ai/api/v1/chat/completions';

export class ProviderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function endpoints(s) {
  if (s.provider === 'cloud') {
    const base = String(s.cloudBase || 'https://jevbrowsercontrol.com').replace(/\/+$/, '');
    return { decisions: `${base}/api/v1/decisions`, chat: `${base}/api/v1/chat/completions`, key: s.cloudKey, chatKey: s.cloudKey, label: 'Jev Browser Control credits' };
  }
  if (s.provider === 'custom') {
    return { decisions: s.customDecisionsUrl, chat: s.customChatUrl || OPENROUTER_CHAT, key: s.customKey, chatKey: s.customChatKey || s.customKey, label: 'Custom endpoint' };
  }
  return { decisions: OPENROUTER_DECISIONS, chat: OPENROUTER_CHAT, key: s.openrouterKey, chatKey: s.openrouterKey, label: 'Your OpenRouter key' };
}

export function makeProvider(settings, { fetchImpl = fetch } = {}) {
  const ep = endpoints(settings);
  let cost = 0;
  let balance = null;

  async function post(url, key, body, { signal } = {}) {
    if (!url) throw new ProviderError('No endpoint configured. Open the Jev Browser Control settings.', { code: 'config' });
    if (!key) throw new ProviderError(`No API key set for "${ep.label}". Open the Jev Browser Control settings.`, { code: 'no_key' });
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Jev Browser Control', 'HTTP-Referer': 'https://jevbrowsercontrol.com' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new ProviderError(`Could not reach ${new URL(url).host}: ${err.message}`, { code: 'network' });
      }
      if ([429, 503, 529].includes(res.status) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) {
        const msg = json?.error?.message || json?.error || text.slice(0, 300);
        const code = /max_tokens_exceeded/.test(text) ? 'max_tokens_exceeded' : res.status === 402 ? 'no_credits' : res.status === 401 ? 'bad_key' : 'http';
        const hint = code === 'no_credits' ? (settings.provider === 'cloud' ? ' Top up at jevbrowsercontrol.com/dashboard.' : ' Top up your OpenRouter credits.')
          : code === 'bad_key' ? ' Check the API key in the Jev Browser Control settings.' : '';
        throw new ProviderError(`${ep.label}: HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${hint}`, { status: res.status, code });
      }
      if (!json) throw new ProviderError(`${ep.label}: response was not JSON`, { code: 'bad_response' });
      cost += Number(json.usage?.cost) || 0;
      if (json.usage?.credits_remaining !== undefined) balance = json.usage.credits_remaining;
      return json;
    }
  }

  return {
    label: ep.label,
    get cost() { return cost; },
    get balance() { return balance; },

    // One Jev request: { model, state, questions } -> { answers, model, usage }
    async decide(body, opts) {
      const model = body.model || settings.jevModel || '~typesafe/jev-latest';
      return post(ep.decisions, ep.key, { ...body, model }, opts);
    },

    // The small LLM that writes a field value. Returns a string, or null when the value is unknown.
    async text(context, opts) {
      const json = await post(ep.chat, ep.chatKey, {
        model: settings.textModel || 'inception/mercury-2.5',
        max_tokens: 300,
        temperature: 0,
        reasoning: { enabled: false },
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: TEXT_VALUE },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }, opts);
      const content = json.choices?.[0]?.message?.content ?? '';
      const raw = String(content).match(/\{[\s\S]*\}/)?.[0]; // small models sometimes wrap JSON in a code fence
      let out;
      try { out = JSON.parse(raw); } catch { throw new ProviderError('The text helper returned no JSON; nothing typed.', { code: 'bad_text' }); }
      if (out.text === null || out.text === undefined || (typeof out.text === 'string' && !out.text.trim())) return { text: null, model: json.model };
      if (typeof out.text === 'number') out.text = String(out.text);
      if (typeof out.text !== 'string' || out.text.length > 2000) throw new ProviderError('The text helper returned no usable value; nothing typed.', { code: 'bad_text' });
      return { text: out.text, model: json.model };
    },
  };
}
