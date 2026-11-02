import crypto from 'node:crypto';
import { reindexSpace, ftsQuery } from './db.js';

export const VISIBILITIES = ['private', 'team', 'unlisted', 'public'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,38}$/;
const MAX_HTML = 5 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'space'
  );
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Store wraps every read and write the app makes. HTTP routes, the MCP server,
 * and the built-in agent all go through it, so permission rules live in one place.
 */
export class Store {
  constructor(db, { bus, sync, secret } = {}) {
    this.db = db;
    this.bus = bus;
    this.sync = sync;
    this.secret = secret || crypto.randomBytes(32).toString('hex');
  }

  // ---------- users and tokens ----------

  createUser({ handle, name, isAdmin = false }) {
    handle = String(handle || '').toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'Handle must be lowercase letters, digits, - or _');
    if (this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) throw new HttpError(409, 'Handle taken');
    const info = this.db
      .prepare('INSERT INTO users (handle, name, is_admin) VALUES (?, ?, ?)')
      .run(handle, name || handle, isAdmin ? 1 : 0);
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  issueToken(userId, label = 'default') {
    const token = 'pst_' + crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO tokens (token_hash, user_id, label) VALUES (?, ?, ?)').run(sha256(token), userId, label);
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    return (
      this.db
        .prepare('SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
        .get(sha256(token)) || null
    );
  }

  userCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  listUsers() {
    return this.db.prepare('SELECT id, handle, name, is_admin, created_at FROM users ORDER BY id').all();
  }

  userByHandle(handle) {
    return this.db.prepare('SELECT * FROM users WHERE handle = ?').get(String(handle).toLowerCase()) || null;
  }

  // ---------- permissions ----------

  canView(space, user) {
    if (space.visibility === 'public' || space.visibility === 'unlisted') return true;
    if (!user) return false;
    if (space.visibility === 'team') return true;
    return user.id === space.owner_id;
  }

  canEdit(space, user) {
    if (!user) return false;
    if (user.id === space.owner_id || user.is_admin) return true;
    return space.visibility !== 'private';
  }

  // ---------- spaces ----------

  getSpace(handle, slug) {
    return (
      this.db
        .prepare(
          `SELECT s.*, u.handle AS owner_handle, u.name AS owner_name
           FROM spaces s JOIN users u ON u.id = s.owner_id
           WHERE u.handle = ? AND s.slug = ?`
        )
        .get(String(handle).toLowerCase(), String(slug).toLowerCase()) || null
    );
  }

  getSpaceById(id) {
    return (
      this.db
        .prepare(
          `SELECT s.*, u.handle AS owner_handle, u.name AS owner_name
           FROM spaces s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`
        )
        .get(id) || null
    );
  }

  /** Resolve a space and enforce view permission. Missing and forbidden look the same to outsiders. */
  requireSpace(handle, slug, user, { edit = false } = {}) {
    const s = this.getSpace(handle, slug);
    if (!s || !this.canView(s, user)) throw new HttpError(404, 'Space not found');
    if (edit && !this.canEdit(s, user)) throw new HttpError(user ? 403 : 401, 'You cannot edit this space');
    return s;
  }

  getVersion(spaceId, n) {
    return this.db.prepare('SELECT * FROM versions WHERE space_id = ? AND n = ?').get(spaceId, n) || null;
  }

  listVersions(spaceId) {
    return this.db
      .prepare('SELECT n, message, author_kind, author_name, created_at, length(html) AS bytes FROM versions WHERE space_id = ? ORDER BY n DESC')
      .all(spaceId);
  }

  /**
   * Create a space or add a version to an existing one. This is the single publish path
   * used by the CLI, MCP, HTTP API, and the built-in agent.
   */
  publish(user, { handle, slug, title, html, emoji, visibility, message, authorKind = 'user', authorName }) {
    if (!user) throw new HttpError(401, 'Sign in to publish');
    if (typeof html !== 'string' || !html.trim()) throw new HttpError(400, 'html is required');
    if (Buffer.byteLength(html) > MAX_HTML) throw new HttpError(413, 'Space is larger than 5 MB');
    if (visibility && !VISIBILITIES.includes(visibility)) throw new HttpError(400, `visibility must be one of ${VISIBILITIES.join(', ')}`);
    const ownerHandle = (handle || user.handle).toLowerCase();
    slug = slugify(slug || title || 'space');
    if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Invalid slug');

    const tx = this.db.transaction(() => {
      let s = this.getSpace(ownerHandle, slug);
      if (!s) {
        if (ownerHandle !== user.handle) throw new HttpError(403, 'You can only create spaces under your own handle');
        const t = title || guessTitle(html) || slug;
        this.db
          .prepare('INSERT INTO spaces (owner_id, slug, title, emoji, visibility) VALUES (?, ?, ?, ?, ?)')
          .run(user.id, slug, t, emoji || '', visibility || 'team');
        s = this.getSpace(ownerHandle, slug);
      } else if (!this.canView(s, user)) {
        throw new HttpError(404, 'Space not found');
      } else if (!this.canEdit(s, user)) {
        throw new HttpError(403, 'You cannot edit this space');
      }
      const n = s.current_version + 1;
      this.db
        .prepare('INSERT INTO versions (space_id, n, html, message, author_kind, author_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.id, n, html, message || (n === 1 ? 'Created' : 'Updated'), authorKind, authorName || user.name);
      const fields = { current_version: n, updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
      if (title) fields.title = title;
      if (emoji !== undefined && emoji !== null) fields.emoji = emoji;
      if (visibility) fields.visibility = visibility;
      const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
      this.db.prepare(`UPDATE spaces SET ${sets} WHERE id = @id`).run({ ...fields, id: s.id });
      reindexSpace(this.db, s.id);
      return this.getSpaceById(s.id);
    });
    const space = tx();
    const version = this.getVersion(space.id, space.current_version);
    this.bus?.emit(space.id, 'version', {
      n: version.n,
      message: version.message,
      author_name: version.author_name,
      author_kind: version.author_kind,
      title: space.title,
      emoji: space.emoji,
      raw: `/raw/${space.id}/${version.n}?k=${this.renderKey(space.id, version.n)}`,
    });
    this.sync?.write(space, version);
    return { space, version };
  }

  updateSpaceMeta(user, handle, slug, { title, emoji, visibility }) {
    const s = this.requireSpace(handle, slug, user, { edit: true });
    if (visibility && !VISIBILITIES.includes(visibility)) throw new HttpError(400, 'Bad visibility');
    if (visibility && user.id !== s.owner_id && !user.is_admin) throw new HttpError(403, 'Only the owner can change visibility');
    this.db
      .prepare('UPDATE spaces SET title = COALESCE(?, title), emoji = COALESCE(?, emoji), visibility = COALESCE(?, visibility) WHERE id = ?')
      .run(title ?? null, emoji ?? null, visibility ?? null, s.id);
    reindexSpace(this.db, s.id);
    const out = this.getSpaceById(s.id);
    this.bus?.emit(s.id, 'meta', { title: out.title, emoji: out.emoji, visibility: out.visibility });
    return out;
  }

  deleteSpace(user, handle, slug) {
    const s = this.requireSpace(handle, slug, user);
    if (!user || (user.id !== s.owner_id && !user.is_admin)) throw new HttpError(403, 'Only the owner can delete a space');
    this.db.prepare('DELETE FROM spaces WHERE id = ?').run(s.id);
    this.db.prepare('DELETE FROM spaces_fts WHERE space_id = ?').run(s.id);
    this.sync?.remove(s);
  }

  /** Spaces this user can see, newest first. `scope`: all | mine | public | handle */
  listSpaces(user, { scope = 'all', handle, limit = 100 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.slug, s.title, s.emoji, s.visibility, s.current_version, s.updated_at, s.created_at, s.owner_id,
                u.handle AS owner_handle, u.name AS owner_name,
                (SELECT COUNT(*) FROM comments c WHERE c.space_id = s.id) AS comment_count
         FROM spaces s JOIN users u ON u.id = s.owner_id
         ORDER BY s.updated_at DESC, s.id DESC`
      )
      .all();
    return rows
      .filter((s) => {
        if (scope === 'public') return s.visibility === 'public';
        if (scope === 'mine') return user && s.owner_id === user.id;
        if (handle && s.owner_handle !== handle.toLowerCase()) return false;
        if (s.visibility === 'unlisted') return user && (s.owner_id === user.id);
        return this.canView(s, user);
      })
      .slice(0, limit);
  }

  search(user, q, limit = 20) {
    const fq = ftsQuery(q);
    if (!fq) return [];
    const rows = this.db
      .prepare(
        `SELECT space_id, snippet(spaces_fts, 1, '[[', ']]', ' … ', 18) AS snip, bm25(spaces_fts, 8.0, 1.0, 2.0) AS rank
         FROM spaces_fts WHERE spaces_fts MATCH ? ORDER BY rank LIMIT 100`
      )
      .all(fq);
    const out = [];
    for (const r of rows) {
      const s = this.getSpaceById(r.space_id);
      if (!s || !this.canView(s, user)) continue;
      if (s.visibility === 'unlisted' && (!user || user.id !== s.owner_id)) continue;
      out.push({ ...pickSpace(s), snippet: r.snip });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------- comments ----------

  listComments(spaceId) {
    return this.db
      .prepare('SELECT * FROM comments WHERE space_id = ? ORDER BY id')
      .all(spaceId)
      .map(commentOut);
  }

  addComment(user, space, { body, anchor, parentId, authorKind = 'user', authorName }) {
    if (!user && authorKind === 'user') throw new HttpError(401, 'Sign in to comment');
    body = String(body || '').trim();
    if (!body) throw new HttpError(400, 'Comment is empty');
    if (body.length > 8000) throw new HttpError(400, 'Comment is too long');
    if (parentId && !this.db.prepare('SELECT 1 FROM comments WHERE id = ? AND space_id = ?').get(parentId, space.id)) {
      throw new HttpError(400, 'Unknown parent comment');
    }
    const info = this.db
      .prepare('INSERT INTO comments (space_id, version_n, parent_id, author_kind, author_name, body, anchor_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(space.id, space.current_version, parentId || null, authorKind, authorName || user.name, body, anchor ? JSON.stringify(sanitizeAnchor(anchor)) : null);
    reindexSpace(this.db, space.id);
    const c = commentOut(this.db.prepare('SELECT * FROM comments WHERE id = ?').get(info.lastInsertRowid));
    this.bus?.emit(space.id, 'comment', c);
    return c;
  }

  getComment(id) {
    const c = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    return c ? commentOut(c) : null;
  }

  setResolved(user, commentId, resolved) {
    const c = this.getComment(commentId);
    if (!c) throw new HttpError(404, 'Comment not found');
    const s = this.getSpaceById(c.space_id);
    if (!s || !this.canView(s, user) || !user) throw new HttpError(404, 'Comment not found');
    this.db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, commentId);
    const out = this.getComment(commentId);
    this.bus?.emit(s.id, 'comment_update', out);
    return out;
  }

  // ---------- shared state (live records apps can read and write) ----------

  getState(spaceId) {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value_json FROM state WHERE space_id = ?').all(spaceId)) out[r.key] = JSON.parse(r.value_json);
    return out;
  }

  setState(user, space, key, value, by) {
    key = String(key);
    if (!key || key.length > 200) throw new HttpError(400, 'Bad key');
    const json = JSON.stringify(value === undefined ? null : value);
    if (json.length > 256 * 1024) throw new HttpError(413, 'Value too large');
    if (value === null || value === undefined) this.db.prepare('DELETE FROM state WHERE space_id = ? AND key = ?').run(space.id, key);
    else
      this.db
        .prepare(
          `INSERT INTO state (space_id, key, value_json, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(space_id, key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = datetime('now')`
        )
        .run(space.id, key, json, by || user?.name || '');
    this.bus?.emit(space.id, 'state', { key, value: value ?? null, by: by || user?.name || '' });
  }

  // ---------- live data streams ----------

  pushStream(space, stream, value) {
    stream = String(stream || '');
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(stream)) throw new HttpError(400, 'Stream names use letters, digits, _ . -');
    const json = JSON.stringify(value);
    if (json === undefined || json.length > 64 * 1024) throw new HttpError(400, 'Bad stream value');
    const info = this.db.prepare('INSERT INTO stream_points (space_id, stream, value_json) VALUES (?, ?, ?)').run(space.id, stream, json);
    this.db
      .prepare('DELETE FROM stream_points WHERE space_id = ? AND stream = ? AND id <= ?')
      .run(space.id, stream, info.lastInsertRowid - 1000);
    const point = this.db.prepare('SELECT created_at FROM stream_points WHERE id = ?').get(info.lastInsertRowid);
    const evt = { stream, value, t: point.created_at };
    this.bus?.emit(space.id, 'stream', evt);
    return evt;
  }

  streamHistory(spaceId, limit = 200) {
    const rows = this.db
      .prepare(
        `SELECT stream, value_json, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY stream ORDER BY id DESC) AS rn FROM stream_points WHERE space_id = ?
         ) WHERE rn <= ? ORDER BY id`
      )
      .all(spaceId, limit);
    const out = {};
    for (const r of rows) (out[r.stream] ||= []).push({ value: JSON.parse(r.value_json), t: r.created_at });
    return out;
  }

  // ---------- signed render URLs for the sandboxed iframe ----------

  renderKey(spaceId, n) {
    return crypto.createHmac('sha256', this.secret).update(`${spaceId}:${n}`).digest('base64url').slice(0, 32);
  }

  checkRenderKey(spaceId, n, key) {
    const want = this.renderKey(spaceId, n);
    return typeof key === 'string' && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
  }
}

export function pickSpace(s) {
  return {
    handle: s.owner_handle,
    slug: s.slug,
    title: s.title,
    emoji: s.emoji,
    visibility: s.visibility,
    version: s.current_version,
    owner: s.owner_name,
    updated_at: s.updated_at,
    path: `/@${s.owner_handle}/${s.slug}`,
    ...(s.comment_count !== undefined ? { comments: s.comment_count } : {}),
  };
}

function commentOut(c) {
  return {
    id: c.id,
    space_id: c.space_id,
    version: c.version_n,
    parent_id: c.parent_id,
    author_kind: c.author_kind,
    author_name: c.author_name,
    body: c.body,
    anchor: c.anchor_json ? JSON.parse(c.anchor_json) : null,
    resolved: !!c.resolved,
    created_at: c.created_at,
  };
}

function sanitizeAnchor(a) {
  return {
    selector: String(a.selector || '').slice(0, 500),
    text: String(a.text || '').slice(0, 300),
    tag: String(a.tag || '').slice(0, 20),
  };
}

function guessTitle(html) {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html) || /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
}
