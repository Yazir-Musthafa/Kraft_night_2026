// Nearby helpers: other CHER watches close to the person are alerted FIRST, before any phone contact is called.
//
//   dispatchNearby   pop-up (help:request) on every eligible watch in range, then a NEARBY_TIMEOUT is scheduled
//   helperRespond    ACCEPT -> the helper gets the person's live location (help:update) and becomes the responder
//                    DECLINE -> if everybody declined, contacts are called right away
//   helperStatus     on my way / arrived / need backup / person safe, mapped onto the normal responder lifecycle
//   onNearbyTimeout  nobody accepted in time -> unanswered requests expire and the phone contact chain starts
//
// A helper is an ordinary responder with the id "H:<watchId>", so coverage, follow-ups, backup and resolution all reuse
// the response chain. The person's own watch never receives help:* events (they go to the helper's watch room and to
// the per-emergency "helpers:<id>" room, which only accepted helpers join).
//
// NOTE: nearby.js (a separate watch registry: upsertWatch/findEligible) is a different module written in parallel.
// This file keeps its own registry (K.helpers) until the two are merged.
import { config } from './config.js';
import { K, getJson, setJson, safe, withLock } from './redis.js';
import { bus, publish } from './events.js';
import { logger } from './logging.js';
import { bearingDegrees, compass8, distanceMeters } from './geo.js';
import { getLatestLocation } from './location.js';
import * as scheduler from './scheduler.js';
import { situationOf } from './advice.js';
import {
  ApiError, COORDINATOR, activeEmergencyForWatch, addEvent, broadcast, findEmergency, getEmergency, getEmergencyResponder, getEmergencyResponders,
  isTerminal, markResponsibility, mutate, saveEmergencyResponder, setResponsible, setCountdown, clearCountdown,
} from './emergency.js';
import { contactNextResponder, helpConfirmed, resolveEmergency, responderAccepts, responderMoving, responderNeedsBackup, responderReached } from './responseChain.js';

const ACTIVE = ['ACCEPTED', 'MOVING', 'REACHED'];
const REQUEST_TTL_S = 6 * 3600;

export const helperResponderId = (watchId) => `H:${watchId}`;
export const isHelperId = (id) => String(id ?? '').startsWith('H:');
export const watchOfHelper = (id) => String(id).slice(2);

const cleanName = (n) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------------ registry
export async function getHelper(watchId) {
  const raw = await safe((c) => c.hGet(K.helpers(), watchId));
  return raw ? JSON.parse(raw) : null;
}

export async function registerHelper(watchId, { name, available } = {}) {
  const prev = await getHelper(watchId);
  const rec = {
    watchId,
    name: cleanName(name) ?? prev?.name ?? 'Nearby helper',
    available: available ?? prev?.available ?? true,
    registeredAt: prev?.registeredAt ?? Date.now(),
    lastSeen: Date.now(),
  };
  await safe((c) => c.hSet(K.helpers(), watchId, JSON.stringify(rec)));
  return rec;
}

export async function listHelpers() {
  const all = await safe((c) => c.hGetAll(K.helpers()));
  const out = [];
  for (const raw of Object.values(all)) {
    const h = JSON.parse(raw);
    const conn = await getJson(K.connection(h.watchId));
    const loc = await getLatestLocation(h.watchId);
    out.push({ ...h, connected: Boolean(conn?.connected), location: loc ? { latitude: loc.latitude, longitude: loc.longitude, ageSeconds: Math.round((Date.now() - loc.timestamp) / 1000) } : null });
  }
  return out;
}

// ------------------------------------------------------------------ who is nearby
/** Connected, available, recently-located watches within radius that are not busy with their own emergency or another one. */
export async function findNearbyHelpers(emergency) {
  const from = emergency.location;
  if (!from) return { helpers: [], reason: 'NO_LOCATION' };
  const all = await safe((c) => c.hGetAll(K.helpers()));
  const found = [];
  for (const raw of Object.values(all)) {
    const h = JSON.parse(raw);
    if (h.watchId === emergency.watchId || h.available === false) continue;
    if (!(await getJson(K.connection(h.watchId)))?.connected) continue;
    const loc = await getLatestLocation(h.watchId);
    if (!loc || Date.now() - loc.timestamp > config.nearby.locationMaxAgeSeconds * 1000) continue;
    if (await activeEmergencyForWatch(h.watchId)) continue;
    const busy = await getJson(K.helperAssignment(h.watchId));
    if (busy && busy.emergencyId !== emergency.id) {
      const other = await findEmergency(busy.emergencyId);
      if (other && !isTerminal(other.state)) continue;
    }
    const distanceM = distanceMeters(loc, from);
    if (distanceM > config.nearby.radiusMeters) continue;
    found.push({ ...h, distanceM: Math.round(distanceM), bearingDeg: bearingDegrees(loc, from) });
  }
  found.sort((a, b) => a.distanceM - b.distanceM);
  return { helpers: found.slice(0, config.nearby.maxAlerted), reason: found.length ? null : 'NONE_IN_RANGE' };
}

/** What a helper watch is told before accepting: distance and rough direction only, never the exact spot. */
const requestPayload = (e, h, expiresAt) => ({
  emergencyId: e.id,
  personName: config.userName,
  distanceM: h.distanceM,
  direction: compass8(h.bearingDeg),
  priority: e.priority,
  expiresAt,
  waitSeconds: config.timing.nearbyWaitSeconds(),
});

/** What an accepted helper sees: the person's live location and the state of the response. */
function assignmentView(e, rec) {
  return {
    emergencyId: e.id,
    personName: config.userName,
    state: e.state,
    priority: e.priority,
    responderStatus: rec.status,
    role: rec.role,
    situation: situationOf(e),
    location: e.location ? { latitude: e.location.latitude, longitude: e.location.longitude, accuracy: e.location.accuracy ?? null, timestamp: e.location.timestamp } : null,
    updatedAt: Date.now(),
  };
}

/** Feeds the watch's progress checklist: was the nearby broadcast sent, skipped or empty? */
const setStage = (id, stage) => mutate(id, (em) => { em.nearbyStage = stage; if (stage !== 'ALERTED') clearCountdown(em); });

// ------------------------------------------------------------------ dispatch
/** Alert nearby watches. Returns {alerted}: when > 0 the caller must NOT call contacts yet. */
export async function dispatchNearby(id) {
  if (!config.nearby.enabled) return { alerted: 0 };
  const e = await getEmergency(id);
  if (isTerminal(e.state)) return { alerted: 0 };
  // The person can switch "Nearby Responder Alerts" off on their watch: then nobody nearby is asked, contacts are called at once.
  if (e.nearbyEnabled === false) {
    await addEvent(id, 'NEARBY_SKIPPED', 'Nearby responder broadcast skipped: disabled in settings');
    await setStage(id, 'DISABLED');
    return { alerted: 0 };
  }
  const { helpers, reason } = await findNearbyHelpers(e);
  if (helpers.length === 0) {
    await addEvent(id, 'NEARBY_NONE', reason === 'NO_LOCATION' ? 'No location yet: cannot look for nearby helpers, calling contacts' : 'No nearby helpers in range: calling contacts');
    await setStage(id, 'NONE');
    return { alerted: 0 };
  }
  const expiresAt = Date.now() + config.timing.nearbyWaitSeconds() * 1000;
  for (const h of helpers) {
    await saveEmergencyResponder(id, {
      responderId: helperResponderId(h.watchId), watchId: h.watchId, kind: 'HELPER', name: h.name, role: 'FIRST_RESPONDER',
      status: 'CONTACTING', attempts: 1, pendingAttempt: null, distanceM: h.distanceM, createdAt: Date.now(),
    });
    await setJson(K.helperRequest(h.watchId), { emergencyId: id, expiresAt }, REQUEST_TTL_S);
    publish('help:request', requestPayload(e, h, expiresAt), { watchId: h.watchId });
  }
  await scheduler.schedule({ emergencyId: id, type: 'NEARBY_TIMEOUT', dueAt: expiresAt });
  const n = helpers.length;
  await mutate(id, (em) => {
    markResponsibility(em, 'CONTACT_ATTEMPTED', 'NEARBY');
    setResponsible(em, COORDINATOR.person, COORDINATOR.role, `Wait up to ${config.timing.nearbyWaitSeconds()}s for a nearby helper to accept, then call contacts`);
    em.contactStatus = `Alerting ${plural(n, 'nearby helper')}`;
    em.nearbyStage = 'ALERTED';
    setCountdown(em, 'NEARBY', 'Waiting for a nearby helper', expiresAt);
    return { event: { type: 'NEARBY_ALERTED', message: `Alerted ${plural(n, 'nearby helper')} (closest ${helpers[0].distanceM} m)`, data: { helpers: helpers.map((h) => ({ responderId: helperResponderId(h.watchId), distanceM: h.distanceM })) } } };
  });
  await broadcast(id);
  return { alerted: n };
}

async function closeHelperRequest(watchId, emergencyId, payload) {
  const req = await getJson(K.helperRequest(watchId));
  if (req?.emergencyId === emergencyId) await safe((c) => c.del(K.helperRequest(watchId)));
  publish('help:closed', { emergencyId, ...payload }, { watchId });
}

/** Nobody accepted in time: withdraw the pop-ups and hand over to the phone contact chain. */
export async function onNearbyTimeout(id) {
  const e = await findEmergency(id);
  if (!e || isTerminal(e.state)) return;
  const records = await getEmergencyResponders(id);
  let expired = 0;
  for (const r of records.filter((x) => isHelperId(x.responderId) && x.status === 'CONTACTING')) {
    await saveEmergencyResponder(id, { ...r, status: 'NO_RESPONSE' });
    await closeHelperRequest(r.watchId, id, { state: e.state, reason: 'EXPIRED', message: 'This request expired' });
    expired++;
  }
  await mutate(id, (em) => { if (em.countdown?.kind === 'NEARBY') clearCountdown(em); });
  if (records.some((r) => ACTIVE.includes(r.status) || r.status === 'NEEDS_BACKUP')) return broadcast(id);
  await addEvent(id, 'NEARBY_TIMEOUT', `No nearby helper accepted within ${config.timing.nearbyWaitSeconds()}s (${plural(expired, 'request')} expired): calling contacts`);
  await contactNextResponder(id, { reason: 'nearby-timeout' });
}

// ------------------------------------------------------------------ helper decisions
export async function helperRespond(watchId, { emergencyId, response }) {
  const rid = helperResponderId(watchId);
  const outcome = await withLock(`nearby:${emergencyId}`, async () => {
    const e = await findEmergency(emergencyId);
    const rec = e ? await getEmergencyResponder(emergencyId, rid) : null;
    if (!e || !rec) throw new ApiError(404, 'NOT_FOUND', 'No help request for this watch');
    if (isTerminal(e.state)) throw new ApiError(410, 'REQUEST_CLOSED', 'This emergency is already closed');
    if (ACTIVE.includes(rec.status)) return { already: true, rec };
    if (rec.status !== 'CONTACTING') throw new ApiError(410, 'REQUEST_CLOSED', 'This request is no longer open');
    const records = await getEmergencyResponders(emergencyId);
    if (response === 'ACCEPT') {
      const engaged = records.filter((r) => isHelperId(r.responderId) && ACTIVE.includes(r.status)).length;
      if (engaged >= config.nearby.maxResponders) throw new ApiError(410, 'REQUEST_CLOSED', 'Enough helpers are already on the way');
      await responderAccepts(emergencyId, rid, { via: 'NEARBY' });
      await responderMoving(emergencyId, rid, { via: 'NEARBY' }); // accepting on the watch = heading there; directions start immediately
      return { accepted: true };
    }
    await saveEmergencyResponder(emergencyId, { ...rec, status: 'DECLINED' });
    const stillOpen = records.some((r) => r.responderId !== rid && isHelperId(r.responderId) && r.status === 'CONTACTING');
    const engaged = records.some((r) => ACTIVE.includes(r.status) || r.status === 'NEEDS_BACKUP');
    return { declined: true, callContacts: !stillOpen && !engaged };
  });

  if (outcome.already) return { assignment: assignmentView(await getEmergency(emergencyId), outcome.rec) };

  if (outcome.declined) {
    await closeHelperRequest(watchId, emergencyId, { reason: 'DECLINED', message: 'Thanks. We will ask someone else.' });
    await addEvent(emergencyId, 'HELPER_DECLINED', `${(await getEmergencyResponder(emergencyId, rid))?.name ?? 'Nearby helper'} cannot help`, { responderId: rid });
    if (outcome.callContacts) {
      await scheduler.cancel(emergencyId, (it) => it.type === 'NEARBY_TIMEOUT');
      await mutate(emergencyId, (em) => { if (em.countdown?.kind === 'NEARBY') clearCountdown(em); });
      await addEvent(emergencyId, 'NEARBY_ALL_DECLINED', 'Every nearby helper declined: calling contacts');
      await contactNextResponder(emergencyId, { reason: 'nearby-declined' });
    } else await broadcast(emergencyId);
    return { declined: true };
  }

  await mutate(emergencyId, (em) => {
    markResponsibility(em, 'LOCATION_SHARED', 'WATCH');
    if (em.location) em.locationSharedTs = em.location.timestamp;
    if (em.countdown?.kind === 'NEARBY') clearCountdown(em);
    return { event: { type: 'LOCATION_SHARED_WATCH', message: 'Location and directions shown on the helper watch', data: { responderId: rid } } };
  });
  await setJson(K.helperAssignment(watchId), { emergencyId, responderId: rid, acceptedAt: Date.now() }, REQUEST_TTL_S);
  await safe((c) => c.del(K.helperRequest(watchId)));
  await coverIfEnough(emergencyId);
  await broadcast(emergencyId);
  return { assignment: assignmentView(await getEmergency(emergencyId), await getEmergencyResponder(emergencyId, rid)) };
}

/** Once enough helpers are on the way the remaining open pop-ups are withdrawn ("covered"). */
async function coverIfEnough(id) {
  const records = await getEmergencyResponders(id);
  const engaged = records.filter((r) => isHelperId(r.responderId) && ACTIVE.includes(r.status)).length;
  if (engaged < config.nearby.maxResponders) return;
  const e = await findEmergency(id);
  for (const r of records.filter((x) => isHelperId(x.responderId) && x.status === 'CONTACTING')) {
    await saveEmergencyResponder(id, { ...r, status: 'NO_RESPONSE' });
    await closeHelperRequest(r.watchId, id, { state: e.state, reason: 'COVERED', message: 'Enough helpers are already on the way. Thank you!' });
  }
}

/** A check-in is answered by ANY status report from that helper. */
async function markCheckInAnswered(id, responderId) {
  for (const it of await scheduler.listItems(id)) {
    if (it.responderId !== responderId || it.type !== 'FOLLOWUP_TIMEOUT' || it.status !== 'PENDING') continue;
    if (it.meta?.parentId) await scheduler.markItem(id, it.meta.parentId, { answered: true });
    await scheduler.cancel(id, (x) => x.id === it.id);
  }
}

export async function helperStatus(watchId, { emergencyId, status }) {
  const rid = helperResponderId(watchId);
  const rec = await getEmergencyResponder(emergencyId, rid);
  if (!rec || !(ACTIVE.includes(rec.status) || rec.status === 'NEEDS_BACKUP')) throw new ApiError(404, 'NOT_FOUND', 'This watch is not helping with that emergency');
  await markCheckInAnswered(emergencyId, rid);
  const via = 'NEARBY';
  switch (status) {
    case 'MOVING': await responderMoving(emergencyId, rid, { via }); break;
    case 'REACHED': await responderReached(emergencyId, rid, { via }); break;
    case 'BACKUP': await responderNeedsBackup(emergencyId, rid, { reason: `${rec.name} asked for backup on the watch`, via }); break;
    case 'CONFIRMED': await helpConfirmed(emergencyId, rec.name); break;
    case 'SAFE': await resolveEmergency(emergencyId, { confirmedBy: rec.name, note: 'Confirmed on the helper watch' }); break;
    default: throw new ApiError(400, 'INVALID_PAYLOAD', 'Unknown status');
  }
  const e = await getEmergency(emergencyId);
  return { assignment: assignmentView(e, (await getEmergencyResponder(emergencyId, rid)) ?? rec) };
}

/** Follow-up for a helper is a check-in on their watch (no phone call): "still on your way?" / "is the person OK?". */
export async function helperCheckIn(e, rec, item, type) {
  const expiresAt = Date.now() + config.nearby.checkinSeconds * 1000;
  publish('help:checkin', { emergencyId: e.id, type, expiresAt, state: e.state }, { watchId: rec.watchId ?? watchOfHelper(rec.responderId) });
  await mutate(e.id, (em) => {
    em.followUp.lastType = type;
    em.contactStatus = `Check-in sent to ${rec.name}`;
    return { event: { type: 'FOLLOWUP_STARTED', message: `Follow-up (${type}) check-in sent to ${rec.name}'s watch`, data: { followUpId: item.id, retryCount: item.retryCount } } };
  });
  publish('followup:started', { emergencyId: e.id, followUpId: item.id, type, responderId: rec.responderId }, { emergencyId: e.id, watchId: e.watchId });
  await scheduler.schedule({ emergencyId: e.id, responderId: rec.responderId, type: 'FOLLOWUP_TIMEOUT', dueAt: expiresAt, retryCount: item.retryCount, meta: { parentId: item.id, parentType: item.type } });
  await broadcast(e.id);
}

// ------------------------------------------------------------------ closing
/** The emergency ended (resolved/cancelled): tell every helper watch that still has it open. */
export async function closeNearby(id, state, message) {
  for (const r of await getEmergencyResponders(id)) {
    if (!isHelperId(r.responderId) || !['CONTACTING', 'ACCEPTED', 'MOVING', 'REACHED', 'NEEDS_BACKUP', 'UNRESPONSIVE'].includes(r.status)) continue;
    const watchId = r.watchId ?? watchOfHelper(r.responderId);
    await closeHelperRequest(watchId, id, { state, reason: state, message });
    const a = await getJson(K.helperAssignment(watchId));
    if (a?.emergencyId === id) await safe((c) => c.del(K.helperAssignment(watchId)));
  }
}

// ------------------------------------------------------------------ reconnect
/** What a (re)connecting helper watch must be shown again: an open pop-up and/or an ongoing assignment. */
export async function helperResume(watchId) {
  const rid = helperResponderId(watchId);
  const out = { request: null, assignment: null };
  const req = await getJson(K.helperRequest(watchId));
  if (req && req.expiresAt > Date.now()) {
    const e = await findEmergency(req.emergencyId);
    const rec = e ? await getEmergencyResponder(e.id, rid) : null;
    if (e && !isTerminal(e.state) && rec?.status === 'CONTACTING') {
      const mine = await getLatestLocation(watchId);
      const distanceM = mine && e.location ? Math.round(distanceMeters(mine, e.location)) : rec.distanceM ?? 0;
      const bearing = mine && e.location ? bearingDegrees(mine, e.location) : 0;
      out.request = requestPayload(e, { distanceM, bearingDeg: bearing }, req.expiresAt);
    }
  }
  const a = await getJson(K.helperAssignment(watchId));
  if (a) {
    const e = await findEmergency(a.emergencyId);
    const rec = e ? await getEmergencyResponder(e.id, rid) : null;
    if (e && !isTerminal(e.state) && rec && (ACTIVE.includes(rec.status) || rec.status === 'NEEDS_BACKUP')) out.assignment = { ...assignmentView(e, rec), roomJoin: e.id };
  }
  return out;
}

// ------------------------------------------------------------------ live updates to accepted helpers
const lastSent = new Map(); // emergencyId -> "state|locationTs|nextAction" (skip identical updates)
const UPDATE_EVENTS = new Set(['emergency:updated', 'response:accepted', 'response:moving', 'response:reached', 'response:backup', 'response:unconfirmed']);

let wired = false;
export function initNearby() {
  scheduler.registerHandler('NEARBY_TIMEOUT', (it) => onNearbyTimeout(it.emergencyId));
  if (wired) return;
  wired = true;
  // State changes (from the emergency view every broadcast carries).
  bus.on('publish', (m) => {
    const e = m.payload?.emergency;
    if (!e || !m.emergencyId || !UPDATE_EVENTS.has(m.event)) return;
    const sig = `${e.state}|${e.location?.timestamp ?? ''}|${e.nextAction}`;
    if (lastSent.get(e.id) === sig) return;
    lastSent.set(e.id, sig);
    if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value);
    publish('help:update', { emergencyId: e.id, state: e.state, priority: e.priority, personName: config.userName, location: e.location ? { latitude: e.location.latitude, longitude: e.location.longitude, accuracy: e.location.accuracy ?? null, timestamp: e.location.timestamp } : null, updatedAt: Date.now() }, { room: `helpers:${e.id}` });
  });
  // The person moved: keep the helper's map and directions live.
  bus.on('location:accepted', ({ watchId, location }) => {
    (async () => {
      const e = await activeEmergencyForWatch(watchId);
      if (!e) return;
      publish('help:update', { emergencyId: e.id, state: e.state, priority: e.priority, personName: config.userName, location: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy ?? null, timestamp: location.timestamp }, updatedAt: Date.now() }, { room: `helpers:${e.id}` });
    })().catch((err) => logger.warn('nearby.location_forward_failed', { message: err?.message }));
  });
}
