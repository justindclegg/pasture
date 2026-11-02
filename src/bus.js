/**
 * In-process event bus for live spaces. Each open viewer holds one Server-Sent Events
 * connection per space. Presence is derived from who is connected right now.
 * For multi-node deployments, replace emit() with a Redis or Postgres pub/sub fan-out.
 */
export class Bus {
  constructor() {
    this.rooms = new Map(); // spaceId -> Set<client>
    this.seq = 0;
  }

  join(spaceId, res, viewer) {
    const client = { id: ++this.seq, res, viewer };
    if (!this.rooms.has(spaceId)) this.rooms.set(spaceId, new Set());
    this.rooms.get(spaceId).add(client);
    this.emitPresence(spaceId);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => {
      clearInterval(ping);
      this.rooms.get(spaceId)?.delete(client);
      this.emitPresence(spaceId);
    });
    return client;
  }

  presence(spaceId) {
    const seen = new Map();
    for (const c of this.rooms.get(spaceId) || []) seen.set(c.viewer.key, { name: c.viewer.name, guest: c.viewer.guest });
    return [...seen.values()];
  }

  emitPresence(spaceId) {
    this.emit(spaceId, 'presence', { viewers: this.presence(spaceId) });
  }

  emit(spaceId, type, data) {
    const room = this.rooms.get(spaceId);
    if (!room) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of room) c.res.write(payload);
  }
}
