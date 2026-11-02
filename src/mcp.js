import fs from 'node:fs';
import { HttpError, pickSpace } from './store.js';

const GUIDE = fs.readFileSync(new URL('../docs/space-guide.md', import.meta.url), 'utf8');
const PROTOCOL = '2025-06-18';

const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'publish_space',
    description:
      'Publish a space: a self-contained HTML document your team can read, comment on, and build on. Creates the space if the slug is new, otherwise adds a new version. Read get_space_guide first if you have not.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('URL slug, lowercase-with-dashes, e.g. how-gpus-work'),
        title: str('Human title'),
        html: str('Complete HTML document'),
        emoji: str('One emoji for the gallery'),
        visibility: { type: 'string', enum: ['private', 'team', 'unlisted', 'public'], description: 'Who can open it. Defaults to team on create.' },
        message: str('Version note, e.g. "Added Legal to the chart"'),
        handle: str('Owner handle when updating a teammate\'s space. Defaults to you.'),
      },
      required: ['slug', 'html'],
    },
  },
  {
    name: 'get_space',
    description: 'Fetch a space: metadata, HTML for the current or a given version, version history, and comments.',
    inputSchema: {
      type: 'object',
      properties: { slug: str('Space slug'), handle: str('Owner handle. Defaults to you.'), version: { type: 'integer', description: 'Version number. Defaults to latest.' } },
      required: ['slug'],
    },
  },
  {
    name: 'list_spaces',
    description: 'List spaces you can see, newest first.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'mine', 'public'] }, handle: str('Only spaces owned by this handle') } },
  },
  {
    name: 'search_spaces',
    description: 'Full-text search across space titles, content, and comments.',
    inputSchema: { type: 'object', properties: { query: str('What to look for') }, required: ['query'] },
  },
  {
    name: 'list_comments',
    description: 'List comments on a space. Each comment may be anchored to an element via a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { slug: str('Space slug'), handle: str('Owner handle. Defaults to you.'), unresolved_only: { type: 'boolean' } },
      required: ['slug'],
    },
  },
  {
    name: 'reply_to_comment',
    description: 'Reply to a comment, optionally resolving it. Use after publishing a version that addresses it.',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { type: 'integer' }, body: str('Reply text'), resolve: { type: 'boolean' } },
      required: ['comment_id', 'body'],
    },
  },
  {
    name: 'push_stream',
    description: 'Push a live data point to a named stream on a space. Open viewers receive it instantly via pasture.stream.on(name).',
    inputSchema: {
      type: 'object',
      properties: { slug: str('Space slug'), handle: str('Owner handle. Defaults to you.'), stream: str('Stream name'), value: { description: 'Any JSON value' } },
      required: ['slug', 'stream', 'value'],
    },
  },
  {
    name: 'get_space_guide',
    description: 'How to design a great space and use the pasture runtime (shared state, live streams).',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function createMcpHandler({ store, baseUrlFor }) {
  const call = async (user, name, a = {}, baseUrl) => {
    const handle = a.handle || user.handle;
    switch (name) {
      case 'get_space_guide':
        return GUIDE;
      case 'publish_space': {
        const { space, version } = store.publish(user, { ...a, handle, authorKind: 'agent', authorName: `${user.name} via MCP` });
        return { ...pickSpace(space), url: `${baseUrl()}${pickSpace(space).path}`, version: version.n };
      }
      case 'get_space': {
        const s = store.requireSpace(handle, a.slug, user);
        const v = store.getVersion(s.id, a.version || s.current_version);
        if (!v) throw new HttpError(404, 'No such version');
        return { ...pickSpace(s), url: `${baseUrl()}${pickSpace(s).path}`, html: v.html, versions: store.listVersions(s.id), comments: store.listComments(s.id) };
      }
      case 'list_spaces':
        return store.listSpaces(user, { scope: a.scope || 'all', handle: a.handle }).map((s) => ({ ...pickSpace(s), url: `${baseUrl()}/@${s.owner_handle}/${s.slug}` }));
      case 'search_spaces':
        return store.search(user, a.query).map((s) => ({ ...s, url: `${baseUrl()}${s.path}` }));
      case 'list_comments': {
        const s = store.requireSpace(handle, a.slug, user);
        const all = store.listComments(s.id);
        return a.unresolved_only ? all.filter((c) => !c.resolved) : all;
      }
      case 'reply_to_comment': {
        const parent = store.getComment(a.comment_id);
        if (!parent) throw new HttpError(404, 'Comment not found');
        const s = store.getSpaceById(parent.space_id);
        if (!s || !store.canView(s, user)) throw new HttpError(404, 'Comment not found');
        const reply = store.addComment(user, s, { body: a.body, parentId: parent.parent_id || parent.id, authorKind: 'agent', authorName: `${user.name}'s agent` });
        if (a.resolve) store.setResolved(user, parent.id, true);
        return reply;
      }
      case 'push_stream': {
        const s = store.requireSpace(handle, a.slug, user, { edit: true });
        return store.pushStream(s, a.stream, a.value);
      }
      default:
        throw new HttpError(400, `Unknown tool ${name}`);
    }
  };

  return async function mcp(req, res) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = [];
    for (const m of msgs) {
      if (!m || m.jsonrpc !== '2.0') {
        out.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
        continue;
      }
      if (m.id === undefined) continue; // notification
      const reply = (result) => out.push({ jsonrpc: '2.0', id: m.id, result });
      const fail = (code, message) => out.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      try {
        if (m.method === 'initialize') {
          reply({
            protocolVersion: m.params?.protocolVersion || PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'pasture', version: '0.1.0' },
            instructions: `Pasture hosts "spaces": HTML documents your user's team reads, comments on, and builds on. When the user asks you to use Pasture, make a space instead of a wall of text, publish it with publish_space, and share the returned url.\n\n${GUIDE}`,
          });
        } else if (m.method === 'ping') reply({});
        else if (m.method === 'tools/list') reply({ tools: TOOLS });
        else if (m.method === 'tools/call') {
          if (!req.user) {
            fail(-32001, 'Unauthorized: pass Authorization: Bearer <pasture token>');
            continue;
          }
          try {
            const result = await call(req.user, m.params?.name, m.params?.arguments || {}, () => baseUrlFor(req));
            reply({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
          } catch (e) {
            reply({ isError: true, content: [{ type: 'text', text: e.message }] });
          }
        } else fail(-32601, `Method not found: ${m.method}`);
      } catch (e) {
        fail(-32603, e.message);
      }
    }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  };
}
