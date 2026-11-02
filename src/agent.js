import fs from 'node:fs';

const GUIDE = fs.readFileSync(new URL('../docs/space-guide.md', import.meta.url), 'utf8');

const SYSTEM = `You are the Pasture agent. You build and edit "spaces": single self-contained HTML documents
that a team reads, comments on, and works in together. You design each one from scratch for its content.

${GUIDE}

## How to reply

Reply in exactly this format and nothing else:

TITLE: <short title for the space>
EMOJI: <one emoji that fits>
SUMMARY: <one short sentence, past tense, saying what you made or changed, written to the person who asked>
\`\`\`html
<the complete HTML document>
\`\`\`

When editing, keep everything the request does not ask you to change, including ids, data, and scripts.
Never return a partial document or a diff.`;

/** Minimal provider layer: Anthropic Messages API, or any OpenAI-compatible Chat Completions server. */
export function agentFromEnv(env = process.env) {
  const provider = (env.PASTURE_AGENT_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : env.PASTURE_LLM_API_KEY || env.OPENAI_API_KEY ? 'openai' : '')).toLowerCase();
  if (!provider) return null;
  if (provider === 'anthropic') {
    return new Agent({
      provider,
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      model: env.PASTURE_AGENT_MODEL || 'claude-sonnet-4-5',
    });
  }
  return new Agent({
    provider: 'openai',
    apiKey: env.PASTURE_LLM_API_KEY || env.OPENAI_API_KEY,
    baseUrl: (env.PASTURE_LLM_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.PASTURE_AGENT_MODEL || 'gpt-4.1',
  });
}

export class Agent {
  constructor({ provider, apiKey, baseUrl, model, maxTokens = 32000, fetchImpl = fetch }) {
    Object.assign(this, { provider, apiKey, baseUrl, model, maxTokens, fetchImpl });
  }

  get label() {
    return `${this.provider}:${this.model}`;
  }

  async complete(user) {
    if (this.provider === 'anthropic') {
      const r = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, system: SYSTEM, messages: [{ role: 'user', content: user }], stream: true }),
      });
      if (!r.ok) throw new Error(`Model error ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return readSse(r, (evt) => (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' ? evt.delta.text : ''));
    }
    const r = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, stream: true, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`Model error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return readSse(r, (evt) => evt.choices?.[0]?.delta?.content || '');
  }

  async create({ prompt, requester }) {
    const text = await this.complete(`${requester ? `${requester} asked` : 'Request'}: ${prompt}\n\nCreate a new space for this.`);
    return parseReply(text);
  }

  async edit({ space, html, request, anchor, requester, thread = [] }) {
    const parts = [
      `Space: "${space.title}" (/@${space.owner_handle}/${space.slug}, version ${space.current_version})`,
      '',
      'Current HTML:',
      '```html',
      html,
      '```',
      '',
    ];
    if (thread.length) {
      parts.push('Earlier messages in this comment thread:');
      for (const c of thread) parts.push(`- ${c.author_name}: ${c.body}`);
      parts.push('');
    }
    if (anchor?.selector) {
      parts.push(`The comment is pinned to the element at CSS selector \`${anchor.selector}\`${anchor.text ? ` whose text begins "${anchor.text}"` : ''}.`);
    }
    parts.push(`${requester || 'A teammate'} asked: ${request}`, '', 'Return the full updated document.');
    return parseReply(await this.complete(parts.join('\n')));
  }
}

async function readSse(res, pick) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        if (evt.type === 'error') throw new Error(evt.error?.message || 'Model stream error');
        out += pick(evt);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return out;
}

export function parseReply(text) {
  const field = (name) => (new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(text) || [])[1]?.trim();
  let html = null;
  const blocks = [...text.matchAll(/```html\s*\n([\s\S]*?)```/gi)];
  if (blocks.length) html = blocks.sort((a, b) => b[1].length - a[1].length)[0][1];
  else {
    const start = text.search(/<!doctype html|<html/i);
    if (start >= 0) html = text.slice(start).replace(/```\s*$/, '');
  }
  if (!html || !/<\/(html|body)>|<body/i.test(html)) throw new Error('The model did not return a complete HTML document');
  return { title: field('TITLE'), emoji: field('EMOJI'), summary: field('SUMMARY') || 'Updated the space.', html: html.trim() + '\n' };
}
