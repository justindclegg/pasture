/**
 * The `pasture` runtime injected into every space. Spaces run in a sandboxed iframe with an
 * opaque origin, so they never touch cookies or the API directly. Everything goes through
 * postMessage to the viewer shell, which holds the user's session and the live connection.
 */
function runtime() {
  if (window.pasture) return;
  var host = window.parent !== window ? window.parent : null;
  var cache = {};
  var streams = {};
  var stateListeners = {};
  var streamListeners = {};
  var resolveReady;
  var api = {
    me: { name: 'Guest', guest: true },
    space: {},
    ready: new Promise(function (r) { resolveReady = r; }),
    state: {
      get: function (k) { return clone(cache[k]); },
      all: function () { return clone(cache); },
      set: function (k, v) {
        apply(k, v);
        if (host) host.postMessage({ pasture: 'state:set', key: k, value: v }, '*');
      },
      on: function (k, fn) { (stateListeners[k] = stateListeners[k] || []).push(fn); return function () { off(stateListeners[k], fn); }; },
    },
    stream: {
      history: function (name) { return (streams[name] || []).slice(); },
      on: function (name, fn) { (streamListeners[name] = streamListeners[name] || []).push(fn); return function () { off(streamListeners[name], fn); }; },
    },
  };
  window.pasture = api;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function off(list, fn) { var i = list ? list.indexOf(fn) : -1; if (i >= 0) list.splice(i, 1); }
  function fire(list, arg) { (list || []).slice().forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } }); }
  function apply(k, v) {
    if (JSON.stringify(cache[k]) === JSON.stringify(v)) return;
    if (v === null || v === undefined) delete cache[k]; else cache[k] = clone(v);
    fire(stateListeners[k], clone(v));
    fire(stateListeners['*'], { key: k, value: clone(v) });
  }

  // ---- comment anchoring: pick an element, highlight an element ----
  var picking = false, hoverEl = null, box = null;
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-pasture-ui', '');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2563eb;background:rgba(37,99,235,.08);border-radius:4px;transition:all .08s;display:none';
    document.documentElement.appendChild(box);
    return box;
  }
  function outline(el) {
    var b = ensureBox();
    if (!el) { b.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    b.style.display = 'block';
    b.style.left = r.left - 3 + 'px'; b.style.top = r.top - 3 + 'px';
    b.style.width = r.width + 6 + 'px'; b.style.height = r.height + 6 + 'px';
  }
  function selectorFor(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase(), i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.length && parts[0][0] === '#' ? parts.join(' > ') : 'body > ' + parts.join(' > ');
  }
  function onMove(e) { if (!picking) return; hoverEl = e.target; outline(hoverEl); }
  function onClick(e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    picking = false; outline(null); document.documentElement.style.cursor = '';
    host && host.postMessage({ pasture: 'picked', anchor: { selector: selectorFor(el), text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120), tag: el.tagName.toLowerCase() } }, '*');
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function (e) {
    if (picking && e.key === 'Escape') { picking = false; outline(null); host && host.postMessage({ pasture: 'pick:cancel' }, '*'); }
  }, true);

  window.addEventListener('message', function (e) {
    if (!host || e.source !== host) return;
    var m = e.data || {};
    if (m.pasture === 'init') {
      api.me = m.me; api.space = m.space; cache = m.state || {}; streams = m.streams || {};
      resolveReady(api);
    } else if (m.pasture === 'state') {
      apply(m.key, m.value);
    } else if (m.pasture === 'stream') {
      var list = (streams[m.stream] = streams[m.stream] || []);
      var point = { value: m.value, t: m.t };
      list.push(point); if (list.length > 1000) list.shift();
      fire(streamListeners[m.stream], point);
      fire(streamListeners['*'], { stream: m.stream, value: m.value, t: m.t });
    } else if (m.pasture === 'pick') {
      picking = !!m.on; document.documentElement.style.cursor = picking ? 'crosshair' : ''; if (!picking) outline(null);
    } else if (m.pasture === 'highlight') {
      var el = null; try { el = document.querySelector(m.selector); } catch (err) {}
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { outline(el); setTimeout(function () { outline(null); }, 1600); }, 350);
    }
  });

  if (host) host.postMessage({ pasture: 'hello' }, '*');
  else resolveReady(api);
}

export const RUNTIME_JS = `(${runtime.toString()})();`;

/** Insert the runtime as the first script in the document so spaces can use it immediately. */
export function injectRuntime(html) {
  const tag = `<script data-pasture-runtime>${RUNTIME_JS}</script>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d.index + d[0].length) + tag + html.slice(d.index + d[0].length);
  return tag + html;
}
