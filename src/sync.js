import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Mirrors every space and version into a plain folder, committed to git.
 * Point PASTURE_SYNC_DIR at a clone of your own GitHub repo (or a Google Drive
 * synced folder) and your data lives somewhere you control.
 */
export class GitSync {
  constructor(dir, { remote, branch = 'main', log = console } = {}) {
    this.dir = path.resolve(dir);
    this.remote = remote;
    this.branch = branch;
    this.log = log;
    this.queue = Promise.resolve();
    this.ready = this.#init();
  }

  async #init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      await run('git', ['init', '-q', '-b', this.branch], { cwd: this.dir });
      if (this.remote) await run('git', ['remote', 'add', 'origin', this.remote], { cwd: this.dir }).catch(() => {});
    }
    for (const [k, v] of [['user.name', 'Pasture'], ['user.email', 'pasture@localhost']]) {
      const has = await run('git', ['config', k], { cwd: this.dir }).then(() => true, () => false);
      if (!has) await run('git', ['config', '--local', k, v], { cwd: this.dir });
    }
  }

  #enqueue(fn) {
    this.queue = this.queue.then(() => this.ready).then(fn).catch((e) => this.log.error('[sync]', e.message));
    return this.queue;
  }

  write(space, version) {
    return this.#enqueue(async () => {
      const dir = path.join(this.dir, `@${space.owner_handle}`, space.slug);
      fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), version.html);
      fs.writeFileSync(path.join(dir, 'versions', `${String(version.n).padStart(4, '0')}.html`), version.html);
      fs.writeFileSync(
        path.join(dir, 'space.json'),
        JSON.stringify({ title: space.title, emoji: space.emoji, visibility: space.visibility, version: version.n, updated_at: space.updated_at }, null, 2) + '\n'
      );
      await this.#commit(`@${space.owner_handle}/${space.slug} v${version.n}: ${version.message}`.slice(0, 200));
    });
  }

  remove(space) {
    return this.#enqueue(async () => {
      fs.rmSync(path.join(this.dir, `@${space.owner_handle}`, space.slug), { recursive: true, force: true });
      await this.#commit(`Delete @${space.owner_handle}/${space.slug}`);
    });
  }

  async #commit(message) {
    await run('git', ['add', '-A'], { cwd: this.dir });
    const dirty = await run('git', ['status', '--porcelain'], { cwd: this.dir }).then((r) => r.stdout.trim());
    if (!dirty) return;
    await run('git', ['commit', '-q', '-m', message], { cwd: this.dir });
    if (this.remote) await run('git', ['push', '-q', 'origin', this.branch], { cwd: this.dir }).catch((e) => this.log.error('[sync] push failed:', e.message));
  }
}
