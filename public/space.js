(() => {
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const $ = (id) => document.getElementById(id);
  const frame = $('space');
  const apiBase = `/api/spaces/@${encodeURIComponent(cfg.handle)}/${encodeURIComponent(cfg.slug)}`;
  const live = { state: {}, streams: {}, comments: [], ready: false };
  let frameWaiting = false;
  let anchor = null;
  let version = cfg.version;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, opts = {}) {
    const r = await fetch(apiBase + path, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
    return data;
  }

  // ---------- iframe bridge ----------
  const post = (msg) => frame.contentWindow && frame.contentWindow.postMessage(msg, '*');
  function sendInit() {
    post({
      pasture: 'init',
      me: { name: cfg.me.name, guest: cfg.me.guest },
      space: { handle: cfg.handle, slug: cfg.slug, version, title: cfg.title },
      state: live.state,
      streams: live.streams,
    });
  }
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.pasture === 'hello') {
      if (live.ready) sendInit();
      else frameWaiting = true;
    } else if (m.pasture === 'state:set') {
      if (cfg.me.guest) {
        toast('Sign in to make changes that everyone sees');
        post({ pasture: 'state', key: m.key, value: live.state[m.key] ?? null });
        return;
      }
      live.state[m.key] = m.value;
      api(`/state/${encodeURIComponent(m.key)}`, { method: 'PUT', body: { value: m.value } }).catch((err) => toast(err.message));
    } else if (m.pasture === 'picked') {
      setPicking(false);
      anchor = m.anchor;
      $('anchor-text').textContent = `Pinned to ${m.anchor.text ? `“${m.anchor.text.slice(0, 48)}”` : `<${m.anchor.tag}>`}`;
      $('anchor-chip').hidden = false;
      $('c-body').focus();
    } else if (m.pasture === 'pick:cancel') {
      setPicking(false);
    }
  });

  function setPicking(on) {
    document.body.classList.toggle('picking', on);
    post({ pasture: 'pick', on });
  }

  // ---------- live connection ----------
  function connect() {
    const es = new EventSource(`${apiBase}/events`, { withCredentials: true });
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      live.state = d.state;
      live.streams = d.streams;
      live.comments = d.comments;
      live.ready = true;
      renderComments();
      if (d.agentBusy) setAgent(true);
      if (frameWaiting) {
        frameWaiting = false;
        sendInit();
      }
    });
    es.addEventListener('state', (e) => {
      const d = JSON.parse(e.data);
      if (d.value === null) delete live.state[d.key];
      else live.state[d.key] = d.value;
      post({ pasture: 'state', key: d.key, value: d.value });
    });
    es.addEventListener('stream', (e) => {
      const d = JSON.parse(e.data);
      const list = (live.streams[d.stream] ||= []);
      list.push({ value: d.value, t: d.t });
      if (list.length > 1000) list.shift();
      post({ pasture: 'stream', stream: d.stream, value: d.value, t: d.t });
    });
    es.addEventListener('comment', (e) => {
      const c = JSON.parse(e.data);
      if (!live.comments.some((x) => x.id === c.id)) live.comments.push(c);
      renderComments();
    });
    es.addEventListener('comment_update', (e) => {
      const c = JSON.parse(e.data);
      live.comments = live.comments.map((x) => (x.id === c.id ? c : x));
      renderComments();
    });
    es.addEventListener('presence', (e) => renderPresence(JSON.parse(e.data).viewers));
    es.addEventListener('agent', (e) => {
      const d = JSON.parse(e.data);
      setAgent(d.status === 'working', d.by);
      if (d.status === 'error') toast('The agent could not make that change');
    });
    es.addEventListener('meta', (e) => {
      const d = JSON.parse(e.data);
      $('v-title').textContent = `${d.emoji ? d.emoji + ' ' : ''}${d.title}`;
    });
    es.addEventListener('version', (e) => {
      const d = JSON.parse(e.data);
      const sel = $('v-select');
      const opt = document.createElement('option');
      opt.value = d.n;
      opt.textContent = `v${d.n} · ${d.message.slice(0, 40)}`;
      sel.prepend(opt);
      $('v-title').textContent = `${d.emoji ? d.emoji + ' ' : ''}${d.title}`;
      cfg.latest = d.n;
      if (cfg.viewingLatest) {
        version = d.n;
        sel.value = String(d.n);
        frame.src = d.raw;
        toast(`Version ${d.n} by ${d.author_name}: ${d.message}`);
      } else {
        toast(`Version ${d.n} is out. Switch versions to see it.`);
      }
    });
  }

  function setAgent(on, by) {
    $('agent-chip').hidden = !on;
    if (on) $('agent-text').textContent = by ? `pasture is writing for ${by}…` : 'pasture is writing…';
  }

  function renderPresence(viewers) {
    const el = $('presence');
    const shown = viewers.slice(0, 5);
    el.innerHTML = shown.map((v) => `<span class="avatar${v.guest ? ' guest' : ''}" title="${esc(v.name)}">${esc(initial(v.name))}</span>`).join('') +
      (viewers.length > 5 ? `<span class="avatar guest">+${viewers.length - 5}</span>` : '');
    el.title = viewers.map((v) => v.name).join(', ');
  }

  // ---------- comments ----------
  function ago(ts) {
    const t = new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
    const s = Math.max(1, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }
  const fmtBody = (b) =>
    esc(b)
      .replace(/(^|\s)(@[a-z0-9_-]+)/gi, '$1<span class="mention">$2</span>')
      .replace(/✓ version (\d+)/g, '<span class="ok">✓ version $1</span>');

  function msg(c) {
    const agent = c.author_kind === 'agent';
    return `<div class="msg"><div class="msg-head"><span class="avatar${agent ? ' agent' : ''}">${agent ? '✦' : esc(initial(c.author_name))}</span><strong>${esc(c.author_name)}</strong><span class="msg-time">v${c.version} · ${ago(c.created_at)}</span></div><div class="msg-body">${fmtBody(c.body)}</div></div>`;
  }

  function renderComments() {
    const roots = live.comments.filter((c) => !c.parent_id);
    const open = roots.filter((c) => !c.resolved);
    $('c-count').textContent = open.length || '';
    const order = [...open, ...roots.filter((c) => c.resolved)];
    const el = $('threads');
    if (!roots.length) {
      el.innerHTML = `<p class="muted small" style="margin:4px">No comments yet. Pin one to any element${cfg.agentReady ? ', or mention @pasture to have the agent change the space' : ''}.</p>`;
      return;
    }
    el.innerHTML = order
      .map((root) => {
        const replies = live.comments.filter((c) => c.parent_id === root.id);
        return `<div class="thread${root.resolved ? ' resolved' : ''}" data-id="${root.id}">
          ${root.anchor ? `<button type="button" class="thread-anchor" data-sel="${esc(root.anchor.selector)}" title="Show in space">On ${root.anchor.text ? `“${esc(root.anchor.text.slice(0, 60))}”` : `&lt;${esc(root.anchor.tag)}&gt;`}</button>` : ''}
          ${msg(root)}${replies.map(msg).join('')}
          ${cfg.me.guest ? '' : `<div class="thread-actions"><button type="button" data-act="reply">Reply</button><button type="button" data-act="resolve">${root.resolved ? 'Reopen' : 'Resolve'}</button></div>`}
        </div>`;
      })
      .join('');
    el.scrollTop = el.scrollHeight;
  }

  $('threads').addEventListener('click', async (e) => {
    const a = e.target.closest('.thread-anchor');
    if (a) return post({ pasture: 'highlight', selector: a.dataset.sel });
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const thread = btn.closest('.thread');
    const id = Number(thread.dataset.id);
    if (btn.dataset.act === 'resolve') {
      const root = live.comments.find((c) => c.id === id);
      try {
        await fetch(`/api/comments/${id}/resolve`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolved: !root.resolved }) });
      } catch (err) {
        toast(err.message);
      }
    } else if (btn.dataset.act === 'reply' && !thread.querySelector('.reply-form')) {
      const f = document.createElement('form');
      f.className = 'reply-form';
      f.innerHTML = `<input aria-label="Reply" placeholder="Reply${cfg.agentReady ? ', or @pasture' : ''}" required><button class="btn btn-sm">Send</button>`;
      thread.appendChild(f);
      f.querySelector('input').focus();
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = f.querySelector('input').value.trim();
        if (!body) return;
        try {
          await api('/comments', { method: 'POST', body: { body, parent_id: id } });
          f.remove();
        } catch (err) {
          toast(err.message);
        }
      });
    }
  });

  const composer = $('composer');
  if (composer) {
    $('pin').addEventListener('click', () => setPicking(!document.body.classList.contains('picking')));
    $('clear-anchor').addEventListener('click', () => {
      anchor = null;
      $('anchor-chip').hidden = true;
    });
    $('c-body').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.requestSubmit();
    });
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = $('c-body').value.trim();
      if (!body) return;
      const btn = composer.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await api('/comments', { method: 'POST', body: { body, anchor } });
        $('c-body').value = '';
        anchor = null;
        $('anchor-chip').hidden = true;
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- chrome ----------
  const panel = $('panel');
  const toggle = $('toggle-comments');
  function setPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setPanel(panel.hidden));
  $('close-panel').addEventListener('click', () => setPanel(false));
  if (window.innerWidth > 1100 || location.hash === '#comments') setPanel(true);

  $('v-select').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    location.href = n === cfg.latest ? `/@${cfg.handle}/${cfg.slug}` : `/@${cfg.handle}/${cfg.slug}?v=${n}`;
  });
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/@${cfg.handle}/${cfg.slug}`);
      toast('Link copied');
    } catch {
      toast(`${location.origin}/@${cfg.handle}/${cfg.slug}`);
    }
  });
  const restore = $('restore');
  if (restore) {
    restore.addEventListener('click', async () => {
      try {
        await api('/restore', { method: 'POST', body: { version: cfg.version } });
        location.href = `/@${cfg.handle}/${cfg.slug}`;
      } catch (err) {
        toast(err.message);
      }
    });
  }

  connect();
})();
