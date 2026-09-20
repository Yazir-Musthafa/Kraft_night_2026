// Minimal in-memory implementation of the node-redis commands CHER uses.
// Used by the test-suite (and only there). Production always uses real Redis.
export class MemoryRedis {
  constructor() {
    this.data = new Map(); // key -> {type, value, expiresAt}
    this.failing = false;
  }

  _guard() {
    if (this.failing) throw new Error('simulated redis failure');
  }

  _get(key, type) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt && e.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    if (type && e.type !== type) throw new Error('WRONGTYPE');
    return e;
  }

  _ensure(key, type, init) {
    let e = this._get(key, type);
    if (!e) {
      e = { type, value: init(), expiresAt: 0 };
      this.data.set(key, e);
    }
    return e;
  }

  async ping() {
    this._guard();
    return 'PONG';
  }

  async get(key) {
    this._guard();
    return this._get(key, 'string')?.value ?? null;
  }

  async set(key, value, opts = {}) {
    this._guard();
    if (opts.condition === 'NX' && this._get(key)) return null;
    const ex = opts.expiration?.type === 'EX' ? opts.expiration.value : 0;
    this.data.set(key, { type: 'string', value: String(value), expiresAt: ex ? Date.now() + ex * 1000 : 0 });
    return 'OK';
  }

  async del(keys) {
    this._guard();
    let n = 0;
    for (const k of Array.isArray(keys) ? keys : [keys]) if (this.data.delete(k)) n++;
    return n;
  }

  async exists(key) {
    this._guard();
    return this._get(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    this._guard();
    const e = this._get(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async incr(key) {
    this._guard();
    const e = this._ensure(key, 'string', () => '0');
    e.value = String(Number(e.value) + 1);
    return Number(e.value);
  }

  async hSet(key, field, value) {
    this._guard();
    const e = this._ensure(key, 'hash', () => new Map());
    const isNew = !e.value.has(field);
    e.value.set(field, String(value));
    return isNew ? 1 : 0;
  }

  async hGet(key, field) {
    this._guard();
    return this._get(key, 'hash')?.value.get(field) ?? null;
  }

  async hGetAll(key) {
    this._guard();
    const e = this._get(key, 'hash');
    return e ? Object.fromEntries(e.value) : {};
  }

  async hDel(key, field) {
    this._guard();
    return this._get(key, 'hash')?.value.delete(field) ? 1 : 0;
  }

  async rPush(key, value) {
    this._guard();
    const e = this._ensure(key, 'list', () => []);
    e.value.push(String(value));
    return e.value.length;
  }

  async lRange(key, start, stop) {
    this._guard();
    const l = this._get(key, 'list')?.value ?? [];
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start < 0 ? Math.max(0, l.length + start) : start, end + 1);
  }

  async lLen(key) {
    this._guard();
    return this._get(key, 'list')?.value.length ?? 0;
  }

  async lTrim(key, start, stop) {
    this._guard();
    const e = this._get(key, 'list');
    if (!e) return 'OK';
    const end = stop < 0 ? e.value.length + stop : stop;
    e.value = e.value.slice(start < 0 ? Math.max(0, e.value.length + start) : start, end + 1);
    return 'OK';
  }

  async zAdd(key, member) {
    this._guard();
    const e = this._ensure(key, 'zset', () => new Map());
    const list = Array.isArray(member) ? member : [member];
    let n = 0;
    for (const m of list) {
      if (!e.value.has(m.value)) n++;
      e.value.set(m.value, m.score);
    }
    return n;
  }

  async zRem(key, member) {
    this._guard();
    const e = this._get(key, 'zset');
    if (!e) return 0;
    let n = 0;
    for (const m of Array.isArray(member) ? member : [member]) if (e.value.delete(m)) n++;
    return n;
  }

  async zScore(key, member) {
    this._guard();
    return this._get(key, 'zset')?.value.get(member) ?? null;
  }

  async zCard(key) {
    this._guard();
    return this._get(key, 'zset')?.value.size ?? 0;
  }

  _zSorted(key) {
    const e = this._get(key, 'zset');
    return e ? [...e.value.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)) : [];
  }

  async zRangeByScore(key, min, max) {
    this._guard();
    const lo = min === '-inf' ? -Infinity : Number(min);
    const hi = max === '+inf' ? Infinity : Number(max);
    return this._zSorted(key).filter(([, s]) => s >= lo && s <= hi).map(([m]) => m);
  }

  async zRange(key, start, stop) {
    this._guard();
    const s = this._zSorted(key).map(([m]) => m);
    const end = stop < 0 ? s.length + stop : stop;
    return s.slice(start, end + 1);
  }

  async sAdd(key, member) {
    this._guard();
    const e = this._ensure(key, 'set', () => new Set());
    let n = 0;
    for (const m of Array.isArray(member) ? member : [member]) if (!e.value.has(m)) (e.value.add(m), n++);
    return n;
  }

  async sRem(key, member) {
    this._guard();
    const e = this._get(key, 'set');
    if (!e) return 0;
    let n = 0;
    for (const m of Array.isArray(member) ? member : [member]) if (e.value.delete(m)) n++;
    return n;
  }

  async sMembers(key) {
    this._guard();
    return [...(this._get(key, 'set')?.value ?? [])];
  }

  async *scanIterator({ MATCH } = {}) {
    this._guard();
    const prefix = (MATCH ?? '*').replace(/\*$/, '');
    yield [...this.data.keys()].filter((k) => k.startsWith(prefix) && this._get(k));
  }

  async quit() {}
}
