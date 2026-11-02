// Stream fake thermal-camera readings into @lee/chip-thermals.
// Usage: PASTURE_URL=http://localhost:4321 PASTURE_TOKEN=pst_... npm run simulate
import fs from 'node:fs';

const url = (process.env.PASTURE_URL || 'http://localhost:4321').replace(/\/+$/, '');
let token = process.env.PASTURE_TOKEN;
if (!token && fs.existsSync('data/demo-tokens.json')) token = JSON.parse(fs.readFileSync('data/demo-tokens.json', 'utf8')).lee;
const target = process.env.PASTURE_SPACE || '@lee/chip-thermals';
const [handle, slug] = target.replace(/^@/, '').split('/');

let t = 0;
async function tick() {
  t += 1;
  const load = Math.min(1, Math.max(0.05, 0.45 + 0.4 * Math.sin(t / 25) + (Math.random() - 0.5) * 0.08));
  const celsius = +(32 + load * 50 + (Math.random() - 0.5) * 2).toFixed(1);
  const r = await fetch(`${url}/api/spaces/@${handle}/${slug}/streams/temp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ value: { celsius, load: +load.toFixed(2) } }),
  });
  if (!r.ok) {
    console.error('push failed', r.status, await r.text());
    process.exit(1);
  }
  process.stdout.write(`\r${celsius.toFixed(1)} °C  load ${Math.round(load * 100)}%   `);
}
console.log(`Streaming to ${url}/${target} (Ctrl-C to stop)`);
setInterval(tick, 500);
