import fs from 'node:fs';
import crypto from 'node:crypto';
import { pickSpace } from './store.js';

const PUBLIC = new URL('../public/', import.meta.url);
const assetV = Object.fromEntries(
  fs.readdirSync(PUBLIC).map((f) => [f, crypto.createHash('sha1').update(fs.readFileSync(new URL(f, PUBLIC))).digest('hex').slice(0, 8)])
);
const asset = (f) => `/assets/${f}?v=${assetV[f] || '0'}`;

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VIS_LABEL = { private: 'Private', team: 'Team', unlisted: 'Anyone with the link', public: 'Public' };

function ago(ts) {
  const t = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z')).getTime();
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const mark = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor" opacity=".12"/><path d="M5 15.5c2.2-1.6 4.4-1.6 7 0s4.8 1.6 7 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 11c2.2-1.6 4.4-1.6 7 0s4.8 1.6 7 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity=".5"/></svg>`;

export function layout({ title, user, body, scripts = '', bodyClass = '', head = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · Pasture` : 'Pasture')}</title>
<meta name="description" content="Open source spaces for agent output. Your AI makes the space; your team reads it, comments on it, and builds on it.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(mark.replace('currentColor', '#2f6b4f').replace(/currentColor/g, '#2f6b4f'))}">
<link rel="stylesheet" href="${asset('app.css')}">
${head}
</head>
<body class="${bodyClass}">
${bodyClass.includes('viewer') ? '' : nav(user)}
${body}
${scripts}
</body>
</html>`;
}

function nav(user) {
  return `<header class="nav">
  <a class="brand" href="/">${mark}<span>pasture</span></a>
  <form class="nav-search" action="/search" role="search"><input name="q" type="search" placeholder="Search spaces" aria-label="Search spaces"></form>
  <nav class="nav-links">
    <a href="/docs">Connect your AI</a>
    ${user ? `<a href="/@${esc(user.handle)}" class="me"><span class="avatar">${esc(initial(user.name))}</span><span class="hide-sm">${esc(user.name)}</span></a>` : `<a class="btn btn-sm" href="/login">Sign in</a>`}
  </nav>
</header>`;
}

export const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

function card(s) {
  const p = pickSpace(s);
  return `<a class="card" href="${esc(p.path)}">
  <div class="card-emoji">${esc(p.emoji || '·')}</div>
  <div class="card-body">
    <div class="card-title">${esc(p.title)}</div>
    <div class="card-meta"><span>@${esc(p.handle)}/${esc(p.slug)}</span></div>
    <div class="card-foot"><span>v${p.version}</span><span>${esc(ago(p.updated_at))}</span>${p.comments ? `<span>${p.comments} comment${p.comments === 1 ? '' : 's'}</span>` : ''}${p.visibility !== 'team' ? `<span class="pill">${esc(VIS_LABEL[p.visibility])}</span>` : ''}</div>
  </div>
</a>`;
}

function grid(spaces, empty) {
  if (!spaces.length) return `<div class="empty">${empty}</div>`;
  return `<div class="grid">${spaces.map(card).join('')}</div>`;
}

export function homePage({ user, mine, team, gallery, agentReady, baseUrl }) {
  if (!user) {
    return layout({
      title: '',
      user,
      body: `<main class="wrap">
  <section class="hero">
    <p class="eyebrow">Open source · self-hosted · MIT</p>
    <h1>Your AI makes the space.<br>Your team reads it, comments on it, and builds on it.</h1>
    <p class="lede">Agents write faster than anyone can read. Pasture gives their work a place to land: a live, versioned page at a link your team can open, mark up, and ask the agent to change while everyone watches.</p>
    <div class="cta"><a class="btn" href="/docs">Connect your AI</a><a class="btn btn-ghost" href="/login">Sign in</a></div>
    <pre class="prompt"><code>Use Pasture and give a visual explanation of how GPUs work.</code></pre>
  </section>
  <section class="features">
    <div><h3>Any agent publishes</h3><p>Claude Code, Codex, Cursor, ChatGPT or your own scripts publish over MCP, a CLI, or plain HTTP.</p></div>
    <div><h3>Comment on the exact spot</h3><p>Pin a comment to any element. Write @pasture and the built-in agent makes the change live.</p></div>
    <div><h3>Every change is a version</h3><p>Browse and restore any version. Mirror everything to a git repo you own.</p></div>
    <div><h3>Live data and shared records</h3><p>Stream numbers from servers and sensors. Build CRMs and forms with state everyone edits together.</p></div>
  </section>
  <section><h2 class="section-title">Public gallery</h2>${grid(gallery, 'No public spaces yet.')}</section>
</main>`,
    });
  }
  return layout({
    title: 'Home',
    user,
    body: `<main class="wrap">
  <section class="ask">
    <h1 class="h-page">Spaces</h1>
    ${
      agentReady
        ? `<form id="ask" class="ask-form">
      <label for="ask-input" class="sr">Ask the agent to make a space</label>
      <textarea id="ask-input" name="prompt" rows="2" placeholder="Make a space that compares our three pricing options as a table and a recommendation" required></textarea>
      <div class="ask-row"><select name="visibility" aria-label="Visibility"><option value="team">Team</option><option value="private">Private</option><option value="unlisted">Anyone with the link</option><option value="public">Public</option></select><button class="btn" type="submit">Make a space</button></div>
      <p class="ask-status" role="status"></p>
    </form>`
        : `<div class="notice">Ask your own AI to publish here, or set <code>ANTHROPIC_API_KEY</code> or <code>PASTURE_LLM_API_KEY</code> to turn on the built-in agent. <a href="/docs">Setup guide</a></div>`
    }
  </section>
  <section><h2 class="section-title">Yours</h2>${grid(mine, `Nothing yet. Ask your AI: <code>Use Pasture at ${esc(baseUrl)} and make a space about our Q4 plan.</code>`)}</section>
  <section><h2 class="section-title">Team</h2>${grid(team, 'Spaces your teammates share with the team show up here.')}</section>
</main>`,
    scripts: agentReady ? `<script src="${asset('home.js')}" defer></script>` : '',
  });
}

export function profilePage({ user, owner, spaces }) {
  return layout({
    title: `@${owner.handle}`,
    user,
    body: `<main class="wrap">
  <div class="profile"><span class="avatar avatar-lg">${esc(initial(owner.name))}</span><div><h1 class="h-page">${esc(owner.name)}</h1><p class="muted">@${esc(owner.handle)}</p></div>
  ${user && user.id === owner.id ? `<form method="post" action="/logout" class="push"><button class="btn btn-ghost btn-sm">Sign out</button></form>` : ''}</div>
  ${grid(spaces, 'No spaces you can see.')}
</main>`,
  });
}

export function searchPage({ user, q, results }) {
  const hl = (s) => esc(s).replace(/\[\[/g, '<mark>').replace(/\]\]/g, '</mark>');
  return layout({
    title: q ? `Search: ${q}` : 'Search',
    user,
    body: `<main class="wrap narrow">
  <form action="/search" class="search-big"><input name="q" type="search" value="${esc(q)}" placeholder="Ask in your own words" aria-label="Search" autofocus><button class="btn">Search</button></form>
  ${
    q
      ? results.length
        ? `<ol class="results">${results
            .map(
              (r) => `<li><a href="${esc(r.path)}"><span class="r-emoji">${esc(r.emoji || '·')}</span><span><span class="r-title">${esc(r.title)}</span><span class="r-path">@${esc(r.handle)}/${esc(r.slug)} · v${r.version}</span><span class="r-snip">${hl(r.snippet)}</span></span></a></li>`
            )
            .join('')}</ol>`
        : `<div class="empty">No spaces match “${esc(q)}”.</div>`
      : ''
  }
</main>`,
  });
}

export function loginPage({ user, error, bootstrap }) {
  return layout({
    title: 'Sign in',
    user,
    body: `<main class="wrap narrow">
  <h1 class="h-page">Sign in</h1>
  <p class="muted">Paste a Pasture token. The server prints the first admin token on startup; admins create more with <code>pasture admin add-user</code>.</p>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  <form method="post" action="/login" class="stack">
    <label>Token<input name="token" type="password" autocomplete="off" required placeholder="pst_..."></label>
    <button class="btn">Sign in</button>
  </form>
  ${bootstrap ? `<p class="muted small">No users exist yet. Restart the server to generate an admin token.</p>` : ''}
</main>`,
  });
}

export function docsPage({ user, baseUrl }) {
  const b = esc(baseUrl);
  return layout({
    title: 'Connect your AI',
    user,
    body: `<main class="wrap narrow prose">
  <h1 class="h-page">Connect your AI</h1>
  <p>Any agent that speaks MCP or can run a shell command can publish spaces. Create a token first (the admin token works, or run <code>pasture token</code>).</p>

  <h2>Claude Code</h2>
  <pre><code>claude mcp add --transport http pasture ${b}/mcp \\
  --header "Authorization: Bearer $PASTURE_TOKEN"</code></pre>

  <h2>Codex</h2>
  <pre><code># ~/.codex/config.toml
[mcp_servers.pasture]
url = "${b}/mcp"
bearer_token_env_var = "PASTURE_TOKEN"</code></pre>

  <h2>Cursor, Windsurf, Gemini CLI, and other MCP clients</h2>
  <pre><code>{
  "mcpServers": {
    "pasture": {
      "url": "${b}/mcp",
      "headers": { "Authorization": "Bearer &lt;your token&gt;" }
    }
  }
}</code></pre>

  <h2>CLI</h2>
  <pre><code>npm link   # from the pasture repo
pasture login ${b} pst_yourtoken
pasture publish report.html --slug q4-plan --title "Q4 plan" -m "First draft"
pasture list
pasture comments q4-plan
pasture stream chip-thermals temp '{"celsius": 61.5}'
pasture pull ./backup</code></pre>

  <h2>Plain HTTP</h2>
  <pre><code>curl -X PUT ${b}/api/spaces/@you/q4-plan \\
  -H "Authorization: Bearer $PASTURE_TOKEN" -H "content-type: application/json" \\
  -d '{"title": "Q4 plan", "html": "&lt;!doctype html&gt;...", "message": "First draft"}'</code></pre>

  <h2>Then ask</h2>
  <pre class="prompt"><code>Use Pasture and give a visual explanation of how GPUs work.</code></pre>
  <p>Agents can read the design guide at <a href="/llms.txt">/llms.txt</a> or through the <code>get_space_guide</code> tool.</p>
</main>`,
  });
}

export function spacePage({ user, space, version, versions, rawUrl, config }) {
  const p = pickSpace(space);
  const viewingOld = version.n !== space.current_version;
  return layout({
    title: space.title,
    user,
    bodyClass: 'viewer',
    body: `<div class="vbar">
  <a class="brand brand-sm" href="/" aria-label="Pasture home">${mark}</a>
  <div class="crumbs"><a href="/@${esc(p.handle)}" class="muted">@${esc(p.handle)}</a><span class="muted">/</span><span class="v-title" id="v-title">${esc(space.emoji ? space.emoji + ' ' : '')}${esc(space.title)}</span></div>
  <div class="v-tools">
    <span class="agent-chip" id="agent-chip" hidden><span class="dot"></span><span id="agent-text">pasture is writing…</span></span>
    <div class="presence" id="presence" aria-label="Who is here"></div>
    <label class="sr" for="v-select">Version</label>
    <select id="v-select" class="v-select">${versions
      .map((v) => `<option value="${v.n}"${v.n === version.n ? ' selected' : ''}>v${v.n} · ${esc(v.message.slice(0, 40))}</option>`)
      .join('')}</select>
    <button class="btn btn-ghost btn-sm" id="copy-link" type="button">Copy link</button>
    <button class="btn btn-sm" id="toggle-comments" type="button" aria-expanded="false" aria-controls="panel">Comments <span id="c-count" class="count"></span></button>
    ${user ? '' : `<a class="btn btn-ghost btn-sm" href="/login">Sign in</a>`}
  </div>
</div>
${viewingOld ? `<div class="old-banner">You are viewing version ${version.n} of ${space.current_version}. <a href="${esc(p.path)}">Go to latest</a>${config.canEdit ? ` · <button type="button" id="restore" class="linklike">Restore this version</button>` : ''}</div>` : ''}
<div class="stage">
  <iframe id="space" title="${esc(space.title)}" src="${esc(rawUrl)}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox" allow="clipboard-write; fullscreen"></iframe>
  <aside class="panel" id="panel" hidden>
    <div class="panel-head"><h2>Comments</h2><button type="button" class="icon-btn" id="close-panel" aria-label="Close comments">×</button></div>
    <div class="threads" id="threads"></div>
    ${
      user
        ? `<form class="composer" id="composer">
      <div class="anchor-chip" id="anchor-chip" hidden><span id="anchor-text"></span><button type="button" class="icon-btn" id="clear-anchor" aria-label="Unpin">×</button></div>
      <textarea id="c-body" rows="3" placeholder="${config.agentReady ? 'Comment, or write @pasture to ask the agent for a change' : 'Write a comment'}" required></textarea>
      <div class="composer-row"><button type="button" class="btn btn-ghost btn-sm" id="pin">Pin to element</button><button class="btn btn-sm" type="submit">Post</button></div>
    </form>`
        : `<p class="muted small pad">Sign in to comment.</p>`
    }
  </aside>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="cfg">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`,
    scripts: `<script src="${asset('space.js')}" defer></script>`,
  });
}

export function errorPage({ user, status, message }) {
  return layout({
    title: String(status),
    user,
    body: `<main class="wrap narrow"><h1 class="h-page">${status === 404 ? 'Nothing here' : 'Something went wrong'}</h1><p class="muted">${esc(message)}</p><p><a href="/">Back home</a></p></main>`,
  });
}
