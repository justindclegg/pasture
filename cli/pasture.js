#!/usr/bin/env node
// Pasture CLI. Zero dependencies beyond Node 20.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pasture', 'config.json');

const HELP = `pasture: publish and work with spaces

Usage
  pasture serve                         Run a Pasture server (PORT, PASTURE_DB, ...)
  pasture login <url> <token>           Save server URL and token
  pasture whoami
  pasture publish <file|-> [--slug s] [--title t] [--emoji e] [--visibility v] [-m message] [--handle h]
  pasture get <slug|@handle/slug> [--version n] [-o file]
  pasture list [--mine]
  pasture search <query>
  pasture comments <slug|@handle/slug> [--open]
  pasture reply <comment-id> <text> [--resolve]
  pasture stream <slug|@handle/slug> <stream> <json-value>
  pasture pull [dir]                    Download every space you can see
  pasture token [label]                 Create another token for yourself
  pasture admin add-user <handle> [--name "Full Name"] [--admin]
  pasture mcp-config                    Print MCP client config

Environment: PASTURE_URL and PASTURE_TOKEN override the saved login.`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m') flags.message = argv[++i];
    else if (a === '-o') flags.out = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

function config() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {}
  const url = (process.env.PASTURE_URL || saved.url || 'http://localhost:4321').replace(/\/+$/, '');
  return { url, token: process.env.PASTURE_TOKEN || saved.token };
}

async function call(method, p, body) {
  const { url, token } = config();
  const r = await fetch(url + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}

async function me() {
  const { user } = await call('GET', '/api/me');
  if (!user) throw new Error('Not signed in. Run: pasture login <url> <token>');
  return user;
}

async function ref(s) {
  if (!s) throw new Error('Missing space');
  const m = /^@?([^/]+)\/(.+)$/.exec(s);
  if (m) return { handle: m[1], slug: m[2] };
  return { handle: (await me()).handle, slug: s };
}
const sp = ({ handle, slug }) => `/api/spaces/@${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;

async function readInput(file) {
  if (!file || file === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  return fs.readFileSync(file, 'utf8');
}

const commands = {
  async serve() {
    await import('../src/server.js').then(async (m) => {
      const { app, bootstrap, agent } = m.createApp();
      const port = Number(process.env.PORT || 4321);
      const boot = bootstrap();
      app.listen(port, () => {
        console.log(`Pasture is running at http://localhost:${port}`);
        console.log(agent ? `Built-in agent: ${agent.label}` : 'Built-in agent: off (set ANTHROPIC_API_KEY or PASTURE_LLM_API_KEY)');
        if (boot) console.log(`\nCreated admin @${boot.user.handle}. Sign in with this token (shown once):\n\n  ${boot.token}\n`);
      });
    });
  },
  async login({ pos }) {
    const [url, token] = pos;
    if (!url || !token) throw new Error('Usage: pasture login <url> <token>');
    const r = await fetch(url.replace(/\/+$/, '') + '/api/me', { headers: { authorization: `Bearer ${token}` } });
    const { user } = await r.json();
    if (!user) throw new Error('That token did not work on ' + url);
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify({ url: url.replace(/\/+$/, ''), token }, null, 2), { mode: 0o600 });
    console.log(`Signed in to ${url} as @${user.handle}`);
  },
  async whoami() {
    const u = await me();
    console.log(`@${u.handle} (${u.name})${u.is_admin ? ' admin' : ''} on ${config().url}`);
  },
  async publish({ pos, flags }) {
    const file = pos[0];
    const html = await readInput(file);
    const slug = flags.slug || (file && file !== '-' ? path.basename(file).replace(/\.[^.]+$/, '') : undefined);
    if (!slug) throw new Error('Pass --slug when publishing from stdin');
    const handle = flags.handle || (await me()).handle;
    const body = { html, title: flags.title, emoji: flags.emoji, visibility: flags.visibility, message: flags.message };
    const out = await call('PUT', sp({ handle, slug }), body);
    console.log(`${out.url}  (v${out.version})`);
  },
  async get({ pos, flags }) {
    const r = await ref(pos[0]);
    const out = await call('GET', sp(r) + (flags.version ? `?v=${flags.version}` : ''));
    if (flags.out) fs.writeFileSync(flags.out, out.html);
    else process.stdout.write(out.html);
  },
  async list({ flags }) {
    const rows = await call('GET', `/api/spaces?scope=${flags.mine ? 'mine' : 'all'}`);
    for (const s of rows) console.log(`${(s.emoji || ' ').padEnd(2)} ${s.path.padEnd(40)} v${String(s.version).padEnd(4)} ${s.title}`);
    if (!rows.length) console.log('No spaces yet.');
  },
  async search({ pos }) {
    const rows = await call('GET', `/api/search?q=${encodeURIComponent(pos.join(' '))}`);
    for (const s of rows) console.log(`${s.path}  ${s.title}\n    ${s.snippet.replace(/\[\[|\]\]/g, '')}`);
    if (!rows.length) console.log('No matches.');
  },
  async comments({ pos, flags }) {
    const rows = await call('GET', sp(await ref(pos[0])) + '/comments');
    for (const c of rows.filter((c) => !flags.open || !c.resolved)) {
      const where = c.anchor ? ` on ${c.anchor.selector}` : '';
      console.log(`${c.parent_id ? '    ↳ ' : ''}#${c.id} ${c.author_name} (v${c.version}${where})${c.resolved ? ' [resolved]' : ''}\n${c.parent_id ? '      ' : '  '}${c.body.replace(/\n/g, '\n  ')}`);
    }
  },
  async reply({ pos, flags }) {
    const [id, ...rest] = pos;
    const out = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply_to_comment', arguments: { comment_id: Number(id), body: rest.join(' '), resolve: !!flags.resolve } } });
    const res = out.result;
    if (res?.isError) throw new Error(res.content[0].text);
    console.log('Replied.');
  },
  async stream({ pos }) {
    const [s, name, json] = pos;
    let value;
    try {
      value = JSON.parse(json);
    } catch {
      value = json;
    }
    const out = await call('POST', `${sp(await ref(s))}/streams/${encodeURIComponent(name)}`, { value });
    console.log(`${name} ← ${JSON.stringify(out.value)} at ${out.t}`);
  },
  async pull({ pos }) {
    const dir = path.resolve(pos[0] || 'pasture-export');
    const rows = await call('GET', '/api/spaces?scope=all');
    for (const s of rows) {
      const full = await call('GET', sp(s));
      const d = path.join(dir, `@${s.handle}`, s.slug);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'index.html'), full.html);
      fs.writeFileSync(path.join(d, 'space.json'), JSON.stringify({ title: s.title, emoji: s.emoji, visibility: s.visibility, version: s.version, versions: full.versions }, null, 2));
      console.log(`${s.path} → ${path.relative(process.cwd(), d)}`);
    }
    console.log(`${rows.length} space(s) saved to ${dir}`);
  },
  async token({ pos }) {
    const out = await call('POST', '/api/tokens', { label: pos[0] || 'cli' });
    console.log(out.token);
  },
  async admin({ pos, flags }) {
    if (pos[0] !== 'add-user' || !pos[1]) throw new Error('Usage: pasture admin add-user <handle> [--name "Full Name"] [--admin]');
    const out = await call('POST', '/api/users', { handle: pos[1], name: typeof flags.name === 'string' ? flags.name : pos[1], admin: !!flags.admin });
    console.log(`Created @${out.user.handle}. Their token (shown once):\n\n  ${out.token}\n`);
  },
  async 'mcp-config'() {
    const { url } = config();
    console.log(JSON.stringify({ mcpServers: { pasture: { url: `${url}/mcp`, headers: { Authorization: 'Bearer <your token>' } } } }, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help' || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd && !commands[cmd] && cmd !== 'help' && cmd !== '-h' && cmd !== '--help' ? 1 : 0);
}
commands[cmd](parseArgs(rest)).catch((e) => {
  console.error(`pasture: ${e.message}`);
  process.exit(1);
});
