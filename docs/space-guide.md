# How to make a great Pasture space

A space is one self-contained HTML document that your team opens at `/@handle/slug`.
People read it, comment on exact elements, and ask `@pasture` to change it. Every
publish creates a new version. Write spaces for a busy reader, not for a transcript.

## Shape the information

- Lead with the answer. The first screen states the conclusion in one sentence.
- Make the key number big. Put the one figure that matters in large type with its unit.
- Show trends as charts, comparisons as tables, processes as diagrams. Prose is the last resort.
- Design each space from scratch for what is in it. A dashboard, a design review, a game, and
  a research brief should not look alike.
- Cite sources with links next to the claim they support.
- Keep it to what a reader can take in within a few minutes. Link out for depth.

## Technical rules

- Return a complete HTML document: `<!doctype html><html>...<head>...</head><body>...</body></html>`.
- Put CSS in `<style>` and JavaScript in `<script>`. You may load libraries from a CDN
  (for example `https://cdn.jsdelivr.net/npm/chart.js`, `https://cdn.jsdelivr.net/npm/d3@7`).
- The space runs in a sandboxed iframe with no cookies and no `localStorage`. Use the
  `pasture` runtime below for anything that must persist or be shared.
- Make it responsive. It must read well from 375px phones to wide monitors.
- Give meaningful elements stable `id` attributes so comments stay anchored across versions.
- Use readable contrast and real text, not text baked into images.

## The `pasture` runtime

Every space gets a global `pasture` object. Wait for it before reading data:

```js
await pasture.ready;

// Who is looking and where
pasture.me;            // { name, guest }
pasture.space;         // { handle, slug, version, title }

// Shared state: records everyone edits together, synced live to every screen.
pasture.state.get('deals');                 // current value or undefined
pasture.state.set('deals', [...]);          // saves and broadcasts (signed-in viewers)
pasture.state.on('deals', (value) => {});   // fires on every change, including your own
pasture.state.all();                        // { key: value, ... }

// Live data streams: machines push numbers in, the space charts them.
pasture.stream.history('temp');             // [{ value, t }, ...] up to 200 recent points
pasture.stream.on('temp', ({ value, t }) => {});
```

Anyone with a token can push to a stream:

```bash
curl -X POST "$PASTURE_URL/api/spaces/@me/chip-thermals/streams/temp" \
  -H "Authorization: Bearer $PASTURE_TOKEN" -H "content-type: application/json" \
  -d '{"value": {"celsius": 48.2, "load": 0.35}}'
```

## Publishing

- MCP: call `publish_space` with `slug`, `title`, `html`, and an optional `message`.
- CLI: `pasture publish space.html --slug how-gpus-work --title "How GPUs work"`.
- HTTP: `PUT /api/spaces/@handle/slug` with JSON `{ "title", "html", "message" }`.

Publishing to an existing slug adds a version. Read open comments with `list_comments`,
address them, then reply with `reply_to_comment` and set `resolve: true`.
