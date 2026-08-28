// llm.js — 多供应商 LLM 客户端：Claude / OpenAI 兼容 / Ollama
// 统一接口：chat({ system, user, maxTokens, temperature }) -> string

const DEFAULTS = {
  claude: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
};

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readError(r) {
  let detail = '';
  try { const j = await r.json(); detail = j.error?.message || JSON.stringify(j).slice(0, 200); }
  catch { detail = r.statusText; }
  return `HTTP ${r.status}: ${detail}`;
}

export class LLMClient {
  constructor({ provider, apiKey, baseUrl, model }) {
    this.provider = provider;
    this.apiKey = apiKey || '';
    this.baseUrl = (baseUrl || DEFAULTS[provider]?.baseUrl || '').replace(/\/+$/, '');
    this.model = model || DEFAULTS[provider]?.model || '';
  }

  get ready() {
    if (this.provider === 'ollama') return !!this.baseUrl && !!this.model;
    return !!this.baseUrl && !!this.model && !!this.apiKey;
  }

  async chat({ system, user, maxTokens = 300, temperature = 0.7 }) {
    switch (this.provider) {
      case 'claude': return this.#claude(system, user, maxTokens, temperature);
      case 'openai': return this.#openai(system, user, maxTokens, temperature);
      case 'ollama': return this.#ollama(system, user, maxTokens, temperature);
      default: throw new Error(`未知供应商: ${this.provider}`);
    }
  }

  async #claude(system, user, maxTokens, temperature) {
    const r = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model, max_tokens: maxTokens, temperature,
        system, messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) throw new Error(await readError(r));
    const data = await r.json();
    return (data.content?.[0]?.text || '').trim();
  }

  async #openai(system, user, maxTokens, temperature) {
    const r = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model, temperature, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!r.ok) throw new Error(await readError(r));
    const data = await r.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }

  async #ollama(system, user, maxTokens, temperature) {
    const r = await fetchWithTimeout(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, stream: false,
        options: { temperature, num_predict: maxTokens },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!r.ok) throw new Error(await readError(r));
    const data = await r.json();
    return (data.message?.content || '').trim();
  }
}
