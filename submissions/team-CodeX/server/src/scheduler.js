// Persistent, restart-safe scheduler. Items live in Redis (a per-emergency hash + a global due-time zset).
// A polling loop claims due items with ZREM (atomic: only one claimant wins), so duplicate runs are prevented.
// Delivery is at-least-once across a crash: recover() re-queues items that were claimed but never finished.
import crypto from 'node:crypto';
import { config } from './config.js';
import { K, safe, isReady } from './redis.js';
import { publish } from './events.js';
import { logger } from './logging.js';

const handlers = new Map();
let timer = null;
let ticking = false;

export function registerHandler(type, fn) {
  handlers.set(type, fn);
}

const member = (emergencyId, itemId) => `${emergencyId}|${itemId}`;

async function saveItem(item) {
  await safe((c) => c.hSet(K.followups(item.emergencyId), item.id, JSON.stringify(item)));
}
async function loadItem(emergencyId, itemId) {
  const raw = await safe((c) => c.hGet(K.followups(emergencyId), itemId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Schedule an item. `type` picks the registered handler.
 * Stored fields: emergencyId, responderId, type, dueAt, retryCount, status.
 */
export async function schedule({ emergencyId, responderId = null, type, delaySeconds = 0, dueAt, retryCount = 0, meta = {} }) {
  const item = {
    id: crypto.randomUUID().slice(0, 12),
    emergencyId,
    responderId,
    type,
    dueAt: dueAt ?? Date.now() + Math.round(delaySeconds * 1000),
    retryCount,
    status: 'PENDING',
    meta,
    errorCount: 0,
    createdAt: Date.now(),
  };
  await saveItem(item);
  await safe((c) => c.zAdd(K.dueZset(), { score: item.dueAt, value: member(emergencyId, item.id) }));
  if (type.startsWith('FOLLOWUP')) {
    publish('followup:scheduled', { emergencyId, followUpId: item.id, type, responderId, dueAt: item.dueAt, retryCount }, { emergencyId });
  }
  logger.debug('scheduler.scheduled', { emergencyId, type, dueAt: item.dueAt, retryCount });
  return item;
}

export async function listItems(emergencyId) {
  const all = await safe((c) => c.hGetAll(K.followups(emergencyId)));
  return Object.values(all).map((s) => JSON.parse(s)).sort((a, b) => a.dueAt - b.dueAt);
}

/** Cancel PENDING items of an emergency. `predicate(item)` narrows which. */
export async function cancel(emergencyId, predicate = () => true) {
  let n = 0;
  for (const item of await listItems(emergencyId)) {
    if (item.status !== 'PENDING' || !predicate(item)) continue;
    await safe((c) => c.zRem(K.dueZset(), member(emergencyId, item.id)));
    item.status = 'CANCELLED';
    await saveItem(item);
    n++;
  }
  return n;
}

export async function markItem(emergencyId, itemId, patch) {
  const item = await loadItem(emergencyId, itemId);
  if (!item) return null;
  Object.assign(item, patch);
  await saveItem(item);
  return item;
}

export async function getItem(emergencyId, itemId) {
  return loadItem(emergencyId, itemId);
}

/** Run everything due at `nowMs`. Returns the number of items executed. */
export async function tick(nowMs = Date.now()) {
  if (ticking) return 0;
  ticking = true;
  let ran = 0;
  try {
    const due = await safe((c) => c.zRangeByScore(K.dueZset(), '-inf', nowMs));
    for (const m of due) {
      const claimed = await safe((c) => c.zRem(K.dueZset(), m));
      if (!claimed) continue; // another worker/tick claimed it
      const [emergencyId, itemId] = m.split('|');
      const item = await loadItem(emergencyId, itemId);
      if (!item || item.status !== 'PENDING') continue;
      item.status = 'RUNNING';
      item.claimedAt = Date.now();
      await saveItem(item);
      const handler = handlers.get(item.type);
      try {
        if (!handler) throw new Error(`no handler for ${item.type}`);
        await handler(item);
        item.status = 'DONE';
        item.completedAt = Date.now();
        await saveItem(item);
        ran++;
      } catch (err) {
        item.errorCount = (item.errorCount ?? 0) + 1;
        logger.error('scheduler.handler_failed', { emergencyId, type: item.type, message: err?.message, errorCount: item.errorCount });
        if (item.errorCount < 3) {
          item.status = 'PENDING';
          item.dueAt = Date.now() + 5000 * item.errorCount;
          await saveItem(item);
          await safe((c) => c.zAdd(K.dueZset(), { score: item.dueAt, value: m }));
        } else {
          item.status = 'FAILED';
          await saveItem(item);
        }
      }
    }
  } finally {
    ticking = false;
  }
  return ran;
}

/**
 * Startup recovery: re-queue PENDING items missing from the due-set and RUNNING items whose claimant died.
 * @param {string[]} activeEmergencyIds
 */
export async function recover(activeEmergencyIds) {
  let requeued = 0;
  for (const id of activeEmergencyIds) {
    for (const item of await listItems(id)) {
      if (item.status === 'RUNNING' || item.status === 'PENDING') {
        const m = member(id, item.id);
        const score = await safe((c) => c.zScore(K.dueZset(), m));
        if (score == null) {
          item.status = 'PENDING';
          item.dueAt = Math.min(item.dueAt, Date.now());
          await saveItem(item);
          await safe((c) => c.zAdd(K.dueZset(), { score: item.dueAt, value: m }));
          requeued++;
        }
      }
    }
  }
  if (requeued) logger.info('scheduler.recovered', { requeued });
  return requeued;
}

export function start() {
  if (timer) return;
  timer = setInterval(() => {
    if (!isReady()) return; // Redis down: try again next poll
    tick().catch((err) => logger.warn('scheduler.tick_failed', { message: err?.message }));
  }, config.scheduler.pollIntervalMs);
  timer.unref?.();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
