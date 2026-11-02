// Seed a local Pasture database with demo people and example spaces.
// Usage: npm run seed   (then npm start)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ex = (f) => fs.readFileSync(path.join(root, 'examples', f), 'utf8');
const { store, bootstrap } = createApp({ agent: null });

const boot = bootstrap();
const tokens = {};
if (boot) tokens[boot.user.handle] = boot.token;

const people = [
  ['ana', 'Ana Ruiz'],
  ['sam', 'Sam Okafor'],
  ['lee', 'Lee Park'],
];
const users = {};
for (const [handle, name] of people) {
  users[handle] = store.userByHandle(handle) || store.createUser({ handle, name });
  if (!fs.existsSync(path.join(root, 'data/demo-tokens.json')) || !JSON.parse(fs.readFileSync(path.join(root, 'data/demo-tokens.json'), 'utf8'))[handle]) {
    tokens[handle] = store.issueToken(users[handle].id, 'demo');
  }
}

function space(user, slug, title, emoji, file, visibility, message) {
  if (store.getSpace(user.handle, slug)) return store.getSpace(user.handle, slug);
  return store.publish(user, { slug, title, emoji, html: ex(file), visibility, message, authorKind: 'agent', authorName: `${user.name} via Claude Code` }).space;
}

const gpu = space(users.sam, 'how-gpus-work', 'How GPUs work', '🖥️', 'how-gpus-work.html', 'public', 'First draft');
space(users.lee, 'chip-thermals', 'Chip thermals', '🌡️', 'chip-thermals.html', 'team', 'Live dashboard for the load test');
space(users.ana, 'sales-crm', 'Q4 pipeline', '📈', 'sales-crm.html', 'team', 'Pipeline board');
const q2 = space(users.ana, 'q2-strategy', 'How we use AI for productivity and joy', '🧭', 'q2-strategy.html', 'team', 'Draft for leadership');

if (!store.listComments(q2.id).length) {
  store.addComment(users.ana, q2, { body: 'Legal is missing? They asked for help with contract review first.', anchor: { selector: '#hours-chart', text: 'Support 9.0 Finance 7.2 Sales 5.5', tag: 'div' } });
  store.addComment(users.sam, q2, { body: 'This is the finding. Lead with it?', anchor: { selector: '#finding', text: 'Teams that pick their own tools love them most', tag: 'blockquote' } });
}
if (!store.listComments(gpu.id).length) {
  store.addComment(users.lee, gpu, { body: 'Why is it so much faster if each core is slower?', anchor: { selector: '#answer', text: 'A GPU draws every pixel at once.', tag: 'h1' } });
}

const tokFile = path.join(root, 'data/demo-tokens.json');
const prev = fs.existsSync(tokFile) ? JSON.parse(fs.readFileSync(tokFile, 'utf8')) : {};
fs.writeFileSync(tokFile, JSON.stringify({ ...prev, ...tokens }, null, 2) + '\n', { mode: 0o600 });
console.log('Seeded demo spaces. Tokens saved to data/demo-tokens.json (keep it private):');
for (const [h, t] of Object.entries({ ...prev, ...tokens })) console.log(`  @${h.padEnd(6)} ${t}`);
