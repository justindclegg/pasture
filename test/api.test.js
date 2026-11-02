import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { Agent, parseReply } from '../src/agent.js';
import { injectRuntime } from '../src/runtime.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pasture-test-'));
const HTML = (h1) => `<!doctype html><html><head><title>${h1}</title></head><body><h1 id="hed">${h1}</h1><p>Quarterly revenue grew forty percent.</p></body></html>`;

// A fake model that streams a valid reply in Anthropic's SSE format.
const fakeFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const prompt = body.messages[0].content;
  const old = /```html\n([\s\S]*?)```/.exec(prompt)?.[1] || HTML('New');
  const html = old.replace(/<h1 id="hed">[^<]*<\/h1>/, '<h1 id="hed">Edited by agent</h1>');
  const text = `TITLE: Agent title\nEMOJI: 🐑\nSUMMARY: Changed the headline.\n\`\`\`html\n${html}\`\`\``;
  const chunks = [text.slice(0, 20), text.slice(20)].map(
    (t) => `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })}\n\n`
  );
  return new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } }), { status: 200 });
};

let server, base, ctx, admin, adminTok, bob, bobTok;

before(async () => {
  ctx = createApp({
    dbFile: path.join(tmp, 'test.db'),
    env: { PASTURE_SYNC_DIR: path.join(tmp, 'sync') },
    agent: new Agent({ provider: 'anthropic', apiKey: 'x', baseUrl: 'http://fake', model: 'fake', fetchImpl: fakeFetch }),
    log: { error() {}, log() {} },
  });
  const boot = ctx.bootstrap();
  admin = boot.user;
  adminTok = boot.token;
  bob = ctx.store.createUser({ handle: 'bob', name: 'Bob' });
  bobTok = ctx.store.issueToken(bob.id);
  await new Promise((r) => (server = ctx.app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = async (method, p, { token, body } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};

test('publish creates a space, republish adds a version', async () => {
  const a = await req('PUT', '/api/spaces/@admin/q4-plan', { token: adminTok, body: { title: 'Q4 plan', html: HTML('Plan v1'), message: 'First' } });
  assert.equal(a.status, 201);
  assert.equal(a.json.version, 1);
  const b = await req('PUT', '/api/spaces/@admin/q4-plan', { token: adminTok, body: { html: HTML('Plan v2'), message: 'Second' } });
  assert.equal(b.status, 200);
  assert.equal(b.json.version, 2);
  const v1 = await req('GET', '/api/spaces/@admin/q4-plan?v=1', { token: adminTok });
  assert.match(v1.json.html, /Plan v1/);
  assert.equal(v1.json.versions.length, 2);
});

test('visibility rules: team needs sign-in, private is owner only, public is open', async () => {
  await req('PUT', '/api/spaces/@admin/secret', { token: adminTok, body: { html: HTML('Secret'), visibility: 'private' } });
  await req('PUT', '/api/spaces/@admin/open', { token: adminTok, body: { html: HTML('Open'), visibility: 'public' } });
  assert.equal((await req('GET', '/api/spaces/@admin/q4-plan')).status, 404);
  assert.equal((await req('GET', '/api/spaces/@admin/q4-plan', { token: bobTok })).status, 200);
  assert.equal((await req('GET', '/api/spaces/@admin/secret', { token: bobTok })).status, 404);
  assert.equal((await req('GET', '/api/spaces/@admin/open')).status, 200);
  assert.equal((await req('PUT', '/api/spaces/@admin/secret', { token: bobTok, body: { html: HTML('x') } })).status, 404);
  assert.equal((await req('PUT', '/api/spaces/@bob/x', { token: adminTok, body: { html: HTML('x') } })).status, 403);
});

test('teammates can build on team spaces but not change visibility', async () => {
  const r = await req('PUT', '/api/spaces/@admin/q4-plan', { token: bobTok, body: { html: HTML('Bob edit'), message: 'Bob' } });
  assert.equal(r.status, 200);
  const p = await req('PATCH', '/api/spaces/@admin/q4-plan', { token: bobTok, body: { visibility: 'public' } });
  assert.equal(p.status, 403);
});

test('search finds spaces by content and respects permissions', async () => {
  const r = await req('GET', '/api/search?q=quarterly%20reven', { token: bobTok });
  const paths = r.json.map((s) => s.path);
  assert.ok(paths.includes('/@admin/q4-plan'));
  assert.ok(!paths.includes('/@admin/secret'));
  const anon = await req('GET', '/api/search?q=quarterly');
  assert.deepEqual(anon.json.map((s) => s.path), ['/@admin/open']);
});

test('raw render requires a valid signed key and is sandboxed', async () => {
  const s = ctx.store.getSpace('admin', 'secret');
  const bad = await req('GET', `/raw/${s.id}/1?k=nope`);
  assert.equal(bad.status, 404);
  const ok = await req('GET', `/raw/${s.id}/1?k=${ctx.store.renderKey(s.id, 1)}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.match(ok.text, /data-pasture-runtime/);
});

test('comments, anchors, replies, and resolve', async () => {
  const c = await req('POST', '/api/spaces/@admin/q4-plan/comments', { token: bobTok, body: { body: 'Lead with the number', anchor: { selector: '#hed', text: 'Plan', tag: 'h1' } } });
  assert.equal(c.status, 201);
  assert.equal(c.json.anchor.selector, '#hed');
  const r = await req('POST', '/api/spaces/@admin/q4-plan/comments', { token: adminTok, body: { body: 'Agreed', parent_id: c.json.id } });
  assert.equal(r.json.parent_id, c.json.id);
  const res = await req('POST', `/api/comments/${c.json.id}/resolve`, { token: adminTok, body: { resolved: true } });
  assert.equal(res.json.resolved, true);
  assert.equal((await req('POST', '/api/spaces/@admin/q4-plan/comments', { body: { body: 'anon' } })).status, 401);
});

test('@pasture mention runs the agent, publishes a version, and replies', async () => {
  const s = ctx.store.getSpace('admin', 'q4-plan');
  const before = s.current_version;
  const c = await req('POST', '/api/spaces/@admin/q4-plan/comments', { token: bobTok, body: { body: '@pasture make the headline punchier', anchor: { selector: '#hed' } } });
  assert.equal(c.status, 201);
  for (let i = 0; i < 50 && ctx.store.getSpace('admin', 'q4-plan').current_version === before; i++) await new Promise((r) => setTimeout(r, 20));
  const after = ctx.store.getSpace('admin', 'q4-plan');
  assert.equal(after.current_version, before + 1);
  const v = ctx.store.getVersion(after.id, after.current_version);
  assert.match(v.html, /Edited by agent/);
  assert.equal(v.author_kind, 'agent');
  await new Promise((r) => setTimeout(r, 30));
  const replies = ctx.store.listComments(after.id).filter((x) => x.parent_id === c.json.id);
  assert.equal(replies.length, 1);
  assert.match(replies[0].body, /Changed the headline\.\n✓ version \d+/);
});

test('generate creates a new space from a prompt', async () => {
  const r = await req('POST', '/api/spaces/generate', { token: bobTok, body: { prompt: 'Explain tides' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.title, 'Agent title');
  assert.equal(r.json.handle, 'bob');
});

test('shared state and streams', async () => {
  const put = await req('PUT', '/api/spaces/@admin/q4-plan/state/deals', { token: bobTok, body: { value: [{ id: 1 }] } });
  assert.equal(put.status, 200);
  assert.deepEqual((await req('GET', '/api/spaces/@admin/q4-plan/state', { token: bobTok })).json, { deals: [{ id: 1 }] });
  const s = await req('POST', '/api/spaces/@admin/q4-plan/streams/temp', { token: adminTok, body: { values: [41, 42, 43] } });
  assert.equal(s.status, 201);
  const h = await req('GET', '/api/spaces/@admin/q4-plan/streams', { token: adminTok });
  assert.deepEqual(h.json.temp.map((p) => p.value), [41, 42, 43]);
  assert.equal((await req('POST', '/api/spaces/@admin/q4-plan/streams/bad name', { token: adminTok, body: { value: 1 } })).status, 400);
});

test('live events stream versions to open viewers', async () => {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/spaces/@admin/q4-plan/events`, { headers: { authorization: `Bearer ${bobTok}` }, signal: ac.signal });
  const reader = r.body.getReader();
  let buf = '';
  const read = async (needle) => {
    while (!buf.includes(needle)) buf += new TextDecoder().decode((await reader.read()).value);
  };
  await read('event: hello');
  await req('PUT', '/api/spaces/@admin/q4-plan', { token: adminTok, body: { html: HTML('Live'), message: 'Live push' } });
  await read('Live push');
  assert.match(buf, /event: version/);
  assert.match(buf, /"raw":"\/raw\/\d+\/\d+\?k=/);
  ac.abort();
});

test('MCP: initialize, list tools, publish, and auth', async () => {
  const init = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } });
  assert.equal(init.json.result.serverInfo.name, 'pasture');
  const list = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.ok(list.json.result.tools.some((t) => t.name === 'publish_space'));
  const noauth = await req('POST', '/mcp', { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_spaces' } } });
  assert.equal(noauth.json.error.code, -32001);
  const pub = await req('POST', '/mcp', {
    token: bobTok,
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'publish_space', arguments: { slug: 'mcp-made', title: 'From MCP', html: HTML('MCP') } } },
  });
  const out = JSON.parse(pub.json.result.content[0].text);
  assert.equal(out.path, '/@bob/mcp-made');
  assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/@bob\/mcp-made$/);
  const note = await req('POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
});

test('git sync mirrors every version', async () => {
  await new Promise((r) => setTimeout(r, 300));
  const dir = path.join(tmp, 'sync');
  await ctx.store.sync.queue;
  assert.ok(fs.existsSync(path.join(dir, '@admin', 'q4-plan', 'index.html')));
  assert.ok(fs.existsSync(path.join(dir, '@admin', 'q4-plan', 'versions', '0001.html')));
  const logOut = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString();
  assert.match(logOut, /@admin\/q4-plan v1: First/);
});

test('admin can invite users; others cannot', async () => {
  assert.equal((await req('POST', '/api/users', { token: bobTok, body: { handle: 'eve' } })).status, 403);
  const r = await req('POST', '/api/users', { token: adminTok, body: { handle: 'cara', name: 'Cara' } });
  assert.equal(r.status, 201);
  assert.match(r.json.token, /^pst_/);
  assert.equal((await req('GET', '/api/me', { token: r.json.token })).json.user.handle, 'cara');
});

test('pages render', async () => {
  for (const p of ['/', '/docs', '/login', '/search?q=plan', '/@admin', '/@admin/open', '/llms.txt']) {
    const r = await req('GET', p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await req('GET', '/@admin/nope')).status, 404);
});

test('parseReply and runtime injection', () => {
  const r = parseReply('TITLE: T\nEMOJI: 🐑\nSUMMARY: Did it.\n```html\n<!doctype html><html><body>x</body></html>\n```');
  assert.equal(r.summary, 'Did it.');
  assert.throws(() => parseReply('no html here'));
  assert.match(injectRuntime('<html><head><title>x</title></head></html>'), /<head><script data-pasture-runtime>/);
});
