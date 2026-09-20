// Redis connection + helpers. Redis is the system of record for all emergency coordination state.
import { createClient } from 'redis';
import { config } from './config.js';
import { logger } from './logging.js';

/** Key builders. Everything lives under the configurable prefix (default "cher"). */
export const K = {
  emergency: (id) => `${config.redisPrefix}:emergency:${id}`,
  events: (id) => `${config.redisPrefix}:emergency:${id}:events`,
  responders: (id) => `${config.redisPrefix}:emergency:${id}:responders`,
  followups: (id) => `${config.redisPrefix}:emergency:${id}:followups`,
  acks: (id) => `${config.redisPrefix}:emergency:${id}:acks`,
  activeSet: () => `${config.redisPrefix}:emergencies:active`,
  allZset: () => `${config.redisPrefix}:emergencies:all`,
  watchActive: (watchId) => `${config.redisPrefix}:watch:${watchId}:active`,
  responder: (id) => `${config.redisPrefix}:responder:${id}`,
  responderSet: () => `${config.redisPrefix}:responders`,
  health: (watchId) => `${config.redisPrefix}:watch:${watchId}:health`,
  location: (watchId) => `${config.redisPrefix}:watch:${watchId}:location`,
  connection: (watchId) => `${config.redisPrefix}:watch:${watchId}:connection`,
  helpers: () => `${config.redisPrefix}:helpers`,
  helperRequest: (watchId) => `${config.redisPrefix}:helper:${watchId}:request`,
  helperAssignment: (watchId) => `${config.redisPrefix}:helper:${watchId}:assignment`,
  dueZset: () => `${config.redisPrefix}:followups:due`,
  call: (cid) => `${config.redisPrefix}:call:${cid}`,
  callBySid: (sid) => `${config.redisPrefix}:callsid:${sid}`,
  idem: (scope, key) => `${config.redisPrefix}:idem:${scope}:${key}`,
  demo: () => `${config.redisPrefix}:demo:state`,
};

let client = null;
let ready = false;
const readyHandlers = [];

/** Register a callback that runs each time Redis (re)connects. */
export function onReady(fn) {
  readyHandlers.push(fn);
}

export function isReady() {
  return ready && client !== null;
}

/** Connect to Redis. Never throws on failure: the server keeps running and reports degraded state. */
export async function connect() {
  if (client) return client;
  const c = createClient({
    url: config.redisUrl,
    socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000), connectTimeout: 5000 },
  });
  c.on('ready', () => {
    ready = true;
    logger.info('redis.ready');
    for (const fn of readyHandlers) Promise.resolve().then(fn).catch((err) => logger.error('redis.ready_handler_failed', { message: err?.message }));
  });
  c.on('end', () => {
    ready = false;
  });
  c.on('error', (err) => {
    ready = false;
    logger.warn('redis.error', { message: err?.message });
  });
  client = c;
  try {
    await c.connect();
  } catch (err) {
    logger.error('redis.connect_failed', { message: err?.message });
  }
  return c;
}

export async function disconnect() {
  if (client && typeof client.quit === 'function') {
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
  }
  client = null;
  ready = false;
}

/** Replace the client (tests). Passing null resets. */
export function setClient(c) {
  client = c;
  ready = c !== null;
}

export class StoreUnavailableError extends Error {
  constructor(cause) {
    super('State store (Redis) unavailable');
    this.name = 'StoreUnavailableError';
    this.code = 'STORE_UNAVAILABLE';
    this.cause = cause;
  }
}

/** Get the live client or throw StoreUnavailableError. */
export function r() {
  if (!client || !ready) throw new StoreUnavailableError();
  return client;
}

/** Wrap a Redis call so any failure surfaces as StoreUnavailableError. */
export async function safe(fn) {
  try {
    return await fn(r());
  } catch (err) {
    if (err instanceof StoreUnavailableError) throw err;
    throw new StoreUnavailableError(err);
  }
}

export async function getJson(key) {
  const raw = await safe((c) => c.get(key));
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setJson(key, value, ttlSeconds) {
  const payload = JSON.stringify(value);
  await safe((c) => (ttlSeconds ? c.set(key, payload, { expiration: { type: 'EX', value: ttlSeconds } }) : c.set(key, payload)));
}

/** Atomically claim a key once (SET NX EX). Returns true if this caller is the first. */
export async function claimOnce(key, ttlSeconds) {
  const res = await safe((c) => c.set(key, '1', { condition: 'NX', expiration: { type: 'EX', value: ttlSeconds } }));
  return res === 'OK';
}

export async function deleteByPrefix(prefix) {
  const keys = [];
  await safe(async (c) => {
    for await (const batch of c.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
      for (const k of Array.isArray(batch) ? batch : [batch]) keys.push(k);
    }
  });
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    await safe((c) => c.del(chunk));
  }
  return keys.length;
}

// Per-key async mutex: serialises read-modify-write on one emergency inside this process.
const locks = new Map();
export async function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((res) => (release = res));
  const chain = prev.then(() => gate);
  locks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

export async function pingRedis() {
  try {
    const t = Date.now();
    await r().ping();
    return { ok: true, latencyMs: Date.now() - t };
  } catch {
    return { ok: false };
  }
}
