import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Store, HttpError, pickSpace, slugify } from './store.js';
import { Bus } from './bus.js';
import { GitSync } from './sync.js';
import { agentFromEnv } from './agent.js';
import { injectRuntime } from './runtime.js';
import { createMcpHandler } from './mcp.js';
import * as views from './views.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs/space-guide.md'), 'utf8');
const MENTION = /(^|[^\w@])@(pasture|agent)\b/i;
const COOKIE = 'pasture_token';

export function createApp(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || console;
  const db = openDb(opts.dbFile || env.PASTURE_DB || path.join(ROOT, 'data/pasture.db'));
  const bus = new Bus();
  const sync = env.PASTURE_SYNC_DIR ? new GitSync(env.PASTURE_SYNC_DIR, { remote: env.PASTURE_SYNC_REMOTE, log }) : null;
  const secret = env.PASTURE_SECRET || loadSecret(db);
  const store = new Store(db, { bus, sync, secret });
  const agent = opts.agent !== undefined ? opts.agent : agentFromEnv(env);
  const agentQueues = new Map();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

  const baseUrlFor = (req) => (env.PASTURE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  // ---------- auth ----------
  app.use((req, res, next) => {
    const h = req.get('authorization') || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    const cookie = parseCookies(req.get('cookie'))[COOKIE];
    req.user = store.userForToken(bearer || cookie);
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const needUser = (req) => {
    if (!req.user) throw new HttpError(401, 'Sign in or pass Authorization: Bearer <token>');
    return req.user;
  };

  app.get('/healthz', (req, res) => res.json({ ok: true, agent: agent ? agent.label : null }));
  app.get('/llms.txt', (req, res) =>
    res.type('text/plain').send(`# Pasture at ${baseUrlFor(req)}\n\nMCP endpoint: ${baseUrlFor(req)}/mcp (Authorization: Bearer <token>)\nHTTP API: PUT ${baseUrlFor(req)}/api/spaces/@<handle>/<slug> with JSON {title, html, message}\n\n${GUIDE}`)
  );

  // ---------- MCP ----------
  const mcp = createMcpHandler({ store, baseUrlFor });
  app.post('/mcp', wrap(mcp));
  app.get('/mcp', (req, res) => res.status(405).set('allow', 'POST').json({ error: 'Use POST for MCP over Streamable HTTP' }));

  // ---------- pages ----------
  app.get('/', (req, res) => {
    const u = req.user;
    const all = store.listSpaces(u);
    res.send(
      views.homePage({
        user: u,
        mine: u ? all.filter((s) => s.owner_id === u.id) : [],
        team: u ? all.filter((s) => s.owner_id !== u.id) : [],
        gallery: store.listSpaces(null, { scope: 'public', limit: 24 }),
        agentReady: !!agent,
        baseUrl: baseUrlFor(req),
      })
    );
  });

  app.get('/login', (req, res) => res.send(views.loginPage({ user: req.user, bootstrap: store.userCount() === 0 })));
  app.post('/login', (req, res) => {
    const token = String(req.body.token || '').trim();
    if (!store.userForToken(token)) return res.status(401).send(views.loginPage({ user: null, error: 'That token did not work.' }));
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
    res.redirect(303, typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/');
  });
  app.post('/logout', (req, res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(303, '/');
  });
  app.get('/docs', (req, res) => res.send(views.docsPage({ user: req.user, baseUrl: baseUrlFor(req) })));
  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').slice(0, 200);
    res.send(views.searchPage({ user: req.user, q, results: q ? store.search(req.user, q) : [] }));
  });

  app.get('/@:handle', (req, res, next) => {
    const owner = store.userByHandle(req.params.handle);
    if (!owner) return next();
    res.send(views.profilePage({ user: req.user, owner, spaces: store.listSpaces(req.user, { handle: owner.handle }) }));
  });

  app.get('/@:handle/:slug', (req, res, next) => {
    const s = store.getSpace(req.params.handle, req.params.slug);
    if (!s || !store.canView(s, req.user)) {
      if (s && !req.user) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return next();
    }
    const n = Number(req.query.v) || s.current_version;
    const v = store.getVersion(s.id, n);
    if (!v) return next();
    const u = req.user;
    res.send(
      views.spacePage({
        user: u,
        space: s,
        version: v,
        versions: store.listVersions(s.id),
        rawUrl: `/raw/${s.id}/${v.n}?k=${store.renderKey(s.id, v.n)}`,
        config: {
          handle: s.owner_handle,
          slug: s.slug,
          spaceId: s.id,
          title: s.title,
          version: v.n,
          latest: s.current_version,
          viewingLatest: v.n === s.current_version,
          me: u ? { name: u.name, handle: u.handle, guest: false } : { name: 'Guest', guest: true },
          canEdit: store.canEdit(s, u),
          agentReady: !!agent,
        },
      })
    );
  });

  // Sandboxed render of one version. The signed key means the iframe needs no cookies.
  app.get('/raw/:id/:n', (req, res, next) => {
    const id = Number(req.params.id);
    const n = Number(req.params.n);
    if (!store.checkRenderKey(id, n, req.query.k)) return next();
    const v = store.getVersion(id, n);
    if (!v) return next();
    res.set({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox',
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.send(injectRuntime(v.html));
  });

  // ---------- JSON API ----------
  const api = express.Router();
  const sp = (req, opts) => store.requireSpace(req.params.handle, req.params.slug, req.user, opts);
  const SPACE = '/spaces/@:handle/:slug';

  api.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, agent: agent ? agent.label : null }));

  api.post('/users', (req, res) => {
    const u = needUser(req);
    if (!u.is_admin) throw new HttpError(403, 'Only admins can add users');
    const created = store.createUser({ handle: req.body.handle, name: req.body.name, isAdmin: !!req.body.admin });
    res.status(201).json({ user: publicUser(created), token: store.issueToken(created.id, 'invite') });
  });
  api.get('/users', (req, res) => {
    needUser(req);
    res.json(store.listUsers());
  });
  api.post('/tokens', (req, res) => {
    const u = needUser(req);
    res.status(201).json({ token: store.issueToken(u.id, String(req.body.label || 'cli').slice(0, 60)) });
  });

  api.get('/spaces', (req, res) => {
    res.json(store.listSpaces(req.user, { scope: req.query.scope || 'all', handle: req.query.handle }).map(pickSpace));
  });
  api.get('/search', (req, res) => res.json(store.search(req.user, String(req.query.q || ''))));

  api.post('/spaces', (req, res) => {
    const u = needUser(req);
    const { space, version } = store.publish(u, { ...req.body, handle: u.handle });
    res.status(version.n === 1 ? 201 : 200).json({ ...pickSpace(space), url: baseUrlFor(req) + pickSpace(space).path });
  });

  api.post('/spaces/generate', wrap(async (req, res) => {
    const u = needUser(req);
    if (!agent) throw new HttpError(503, 'The built-in agent is not configured');
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const out = await agent.create({ prompt, requester: u.name });
    let slug = slugify(req.body.slug || out.title || prompt.slice(0, 50));
    for (let i = 2; store.getSpace(u.handle, slug); i++) slug = `${slugify(out.title || 'space').slice(0, 70)}-${i}`;
    const { space } = store.publish(u, {
      handle: u.handle,
      slug,
      title: out.title || prompt.slice(0, 80),
      emoji: out.emoji || '',
      html: out.html,
      visibility: req.body.visibility,
      message: out.summary,
      authorKind: 'agent',
      authorName: 'pasture agent',
    });
    res.status(201).json({ ...pickSpace(space), url: baseUrlFor(req) + pickSpace(space).path, summary: out.summary });
  }));

  api.get(SPACE, (req, res) => {
    const s = sp(req);
    const v = store.getVersion(s.id, Number(req.query.v) || s.current_version);
    if (!v) throw new HttpError(404, 'No such version');
    res.json({ ...pickSpace(s), html: v.html, version_message: v.message, versions: store.listVersions(s.id) });
  });
  api.put(SPACE, (req, res) => {
    const u = needUser(req);
    const { space, version } = store.publish(u, { ...req.body, handle: req.params.handle, slug: req.params.slug });
    res.status(version.n === 1 ? 201 : 200).json({ ...pickSpace(space), url: baseUrlFor(req) + pickSpace(space).path });
  });
  api.patch(SPACE, (req, res) => {
    const s = store.updateSpaceMeta(needUser(req), req.params.handle, req.params.slug, req.body);
    res.json(pickSpace(s));
  });
  api.delete(SPACE, (req, res) => {
    store.deleteSpace(needUser(req), req.params.handle, req.params.slug);
    res.status(204).end();
  });
  api.get(`${SPACE}/versions`, (req, res) => res.json(store.listVersions(sp(req).id)));
  api.post(`${SPACE}/restore`, (req, res) => {
    const u = needUser(req);
    const s = sp(req, { edit: true });
    const v = store.getVersion(s.id, Number(req.body.version));
    if (!v) throw new HttpError(404, 'No such version');
    const { space } = store.publish(u, { handle: s.owner_handle, slug: s.slug, html: v.html, message: `Restored version ${v.n}` });
    res.json(pickSpace(space));
  });

  api.get(`${SPACE}/comments`, (req, res) => res.json(store.listComments(sp(req).id)));
  api.post(`${SPACE}/comments`, (req, res) => {
    const u = needUser(req);
    const s = sp(req);
    const c = store.addComment(u, s, { body: req.body.body, anchor: req.body.anchor, parentId: req.body.parent_id });
    if (agent && MENTION.test(c.body)) runAgent(s, c, u);
    res.status(201).json(c);
  });
  api.post('/comments/:id/resolve', (req, res) => res.json(store.setResolved(needUser(req), Number(req.params.id), req.body.resolved !== false)));

  api.get(`${SPACE}/state`, (req, res) => res.json(store.getState(sp(req).id)));
  api.put(`${SPACE}/state/:key`, (req, res) => {
    const u = needUser(req);
    const s = sp(req);
    store.setState(u, s, req.params.key, req.body.value, u.name);
    res.json({ ok: true });
  });

  api.get(`${SPACE}/streams`, (req, res) => res.json(store.streamHistory(sp(req).id, Math.min(1000, Number(req.query.limit) || 200))));
  api.post(`${SPACE}/streams/:stream`, (req, res) => {
    needUser(req);
    const s = sp(req, { edit: true });
    const points = Array.isArray(req.body.values) ? req.body.values : [req.body.value];
    let last;
    for (const v of points) last = store.pushStream(s, req.params.stream, v);
    res.status(201).json(last);
  });

  // Live updates: versions, comments, state, streams, presence, agent status.
  api.get(`${SPACE}/events`, (req, res) => {
    const s = sp(req);
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const u = req.user;
    const viewer = u ? { key: `u:${u.id}`, name: u.name, guest: false } : { key: `g:${crypto.randomUUID()}`, name: 'Guest', guest: true };
    res.write(`event: hello\ndata: ${JSON.stringify({ state: store.getState(s.id), streams: store.streamHistory(s.id), comments: store.listComments(s.id), version: s.current_version, agentBusy: agentQueues.has(s.id) })}\n\n`);
    bus.join(s.id, res, viewer);
  });

  app.use('/api', api);

  // ---------- built-in agent ----------
  function runAgent(space, comment, user) {
    const prev = agentQueues.get(space.id) || Promise.resolve();
    const job = prev.then(async () => {
      bus.emit(space.id, 'agent', { status: 'working', by: user.name, comment_id: comment.id });
      const threadId = comment.parent_id || comment.id;
      try {
        const fresh = store.getSpaceById(space.id);
        const html = store.getVersion(fresh.id, fresh.current_version).html;
        const thread = store.listComments(fresh.id).filter((c) => (c.id === threadId || c.parent_id === threadId) && c.id !== comment.id);
        const root = thread.find((c) => c.id === threadId) || comment;
        const out = await agent.edit({ space: fresh, html, request: comment.body, anchor: comment.anchor || root.anchor, requester: user.name, thread });
        const { version } = store.publish(user, {
          handle: fresh.owner_handle,
          slug: fresh.slug,
          html: out.html,
          message: out.summary.slice(0, 200),
          authorKind: 'agent',
          authorName: 'pasture agent',
        });
        store.addComment(null, store.getSpaceById(fresh.id), { body: `${out.summary}\n✓ version ${version.n}`, parentId: threadId, authorKind: 'agent', authorName: 'pasture' });
        bus.emit(space.id, 'agent', { status: 'done', version: version.n });
      } catch (e) {
        log.error('[agent]', e.message);
        store.addComment(null, store.getSpaceById(space.id), { body: `I could not make that change: ${e.message}`, parentId: threadId, authorKind: 'agent', authorName: 'pasture' });
        bus.emit(space.id, 'agent', { status: 'error', message: e.message });
      }
    });
    agentQueues.set(space.id, job);
    job.finally(() => agentQueues.get(space.id) === job && agentQueues.delete(space.id));
    return job;
  }

  // ---------- errors ----------
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).send(views.errorPage({ user: req.user, status: 404, message: 'That space does not exist, or you do not have access.' }));
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error(err);
    const message = status >= 500 ? 'Internal error' : err.message;
    if (req.path.startsWith('/api/') || req.path === '/mcp') return res.status(status).json({ error: message });
    res.status(status).send(views.errorPage({ user: req.user, status, message }));
  });

  // ---------- first run ----------
  function bootstrap() {
    if (store.userCount() > 0) return null;
    const handle = (env.PASTURE_ADMIN_HANDLE || 'admin').toLowerCase();
    const u = store.createUser({ handle, name: env.PASTURE_ADMIN_NAME || handle, isAdmin: true });
    const token = env.PASTURE_ADMIN_TOKEN || store.issueToken(u.id, 'admin');
    if (env.PASTURE_ADMIN_TOKEN) {
      db.prepare('INSERT INTO tokens (token_hash, user_id, label) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), u.id, 'admin');
    }
    return { user: u, token };
  }

  return { app, store, db, bus, agent, bootstrap, runAgent };
}

function loadSecret(db) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM settings WHERE key = 'secret'").get();
  if (row) return row.value;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('secret', ?)").run(s);
  return s;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const publicUser = (u) => ({ id: u.id, handle: u.handle, name: u.name, is_admin: !!u.is_admin });

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { app, bootstrap, agent } = createApp();
  const port = Number(process.env.PORT || 4321);
  const boot = bootstrap();
  app.listen(port, () => {
    console.log(`Pasture is running at http://localhost:${port}`);
    console.log(agent ? `Built-in agent: ${agent.label}` : 'Built-in agent: off (set ANTHROPIC_API_KEY or PASTURE_LLM_API_KEY)');
    if (boot) {
      console.log(`\nCreated admin @${boot.user.handle}. Sign in with this token (shown once):\n\n  ${boot.token}\n`);
    }
  });
}
