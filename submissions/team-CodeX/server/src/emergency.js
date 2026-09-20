// Emergency state: persistence in Redis, explicit state machine, timeline, coverage, responsibility.
// This module holds NO side effects toward the outside world (no Twilio/AI): see responseChain.js.
import crypto from 'node:crypto';
import { config } from './config.js';
import { K, getJson, setJson, safe, withLock, claimOnce } from './redis.js';
import { publish } from './events.js';
import { emergencyLog } from './logging.js';
import { TERMINAL_STATES, PRIORITIES } from './validation.js';
import { deterministicPriority } from './sensors.js';
import { getLatestLocation } from './location.js';
import { getHealthSummary } from './health.js';

export class NotFoundError extends Error {
  constructor(what = 'Emergency') {
    super(`${what} not found`);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.status = 404;
  }
}
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.status = 409;
    this.from = from;
    this.to = to;
  }
}

/** Allowed state transitions. RESOLVED is reachable only from HELP_CONFIRMED (no false resolution). */
export const TRANSITIONS = {
  ACTIVE: ['RESPONDER_SEARCHING', 'RESPONDER_ACCEPTED', 'UNCONFIRMED', 'CANCELLED'],
  RESPONDER_SEARCHING: ['RESPONDER_SEARCHING', 'RESPONDER_ACCEPTED', 'UNCONFIRMED', 'CANCELLED'],
  RESPONDER_ACCEPTED: ['RESPONDER_MOVING', 'PERSON_REACHED', 'RESPONDER_NEEDS_BACKUP', 'RESPONDER_SEARCHING', 'UNCONFIRMED', 'CANCELLED'],
  RESPONDER_MOVING: ['PERSON_REACHED', 'RESPONDER_NEEDS_BACKUP', 'RESPONDER_SEARCHING', 'UNCONFIRMED', 'CANCELLED'],
  RESPONDER_NEEDS_BACKUP: ['RESPONDER_SEARCHING', 'RESPONDER_ACCEPTED', 'PERSON_REACHED', 'UNCONFIRMED', 'CANCELLED'],
  PERSON_REACHED: ['HELP_CONFIRMED', 'RESPONDER_NEEDS_BACKUP', 'UNCONFIRMED', 'CANCELLED'],
  HELP_CONFIRMED: ['RESOLVED', 'RESPONDER_NEEDS_BACKUP', 'CANCELLED'],
  UNCONFIRMED: ['RESPONDER_SEARCHING', 'RESPONDER_ACCEPTED', 'RESPONDER_MOVING', 'RESPONDER_NEEDS_BACKUP', 'PERSON_REACHED', 'CANCELLED'],
  RESOLVED: [],
  CANCELLED: [],
};

export const isTerminal = (state) => TERMINAL_STATES.includes(state);
export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Coverage = weighted share of completed response responsibilities. */
export const COVERAGE_WEIGHTS = [
  { key: 'RECORDED', label: 'Emergency recorded', weight: 10 },
  { key: 'CONTACT_ATTEMPTED', label: 'Responder reached (alert delivered / call answered)', weight: 10 },
  { key: 'LOCATION_SHARED', label: 'Location delivered to a responder', weight: 10 },
  { key: 'RESPONDER_ACCEPTED', label: 'Responder accepted', weight: 25 },
  { key: 'RESPONDER_MOVING', label: 'Responder en route', weight: 10 },
  { key: 'PERSON_REACHED', label: 'Person reached', weight: 25 },
  { key: 'HELP_CONFIRMED', label: 'Help explicitly confirmed', weight: 10 },
];
const ROLE_WEIGHT = 8;

export function computeCoverage(e) {
  const resp = e.responsibilities ?? {};
  const items = COVERAGE_WEIGHTS.map((w) => ({ ...w, done: Boolean(resp[w.key]?.done) }));
  for (const [key, val] of Object.entries(resp)) {
    if (key.startsWith('ROLE:')) items.push({ key, label: `${key.slice(5).toLowerCase().replaceAll('_', ' ')} assigned`, weight: ROLE_WEIGHT, done: Boolean(val.done) });
  }
  const total = items.reduce((a, i) => a + i.weight, 0);
  const done = items.filter((i) => i.done).reduce((a, i) => a + i.weight, 0);
  return { percent: Math.round((done / total) * 100), items };
}

const now = () => Date.now();

// ---------------------------------------------------------------- persistence
async function persist(e) {
  e.lastUpdate = now();
  e.coverage = computeCoverage(e);
  const terminal = isTerminal(e.state);
  await setJson(K.emergency(e.id), e, terminal ? config.limits.historyTtlSeconds : undefined);
  await safe(async (c) => {
    await c.zAdd(K.allZset(), { score: e.createdAt, value: e.id });
    if (terminal) {
      await c.sRem(K.activeSet(), e.id);
      const cur = await c.get(K.watchActive(e.watchId));
      if (cur === e.id) await c.del(K.watchActive(e.watchId));
      await c.expire(K.events(e.id), config.limits.historyTtlSeconds);
      await c.expire(K.responders(e.id), config.limits.historyTtlSeconds);
      await c.expire(K.followups(e.id), config.limits.historyTtlSeconds);
    } else {
      await c.sAdd(K.activeSet(), e.id);
      await c.set(K.watchActive(e.watchId), e.id);
    }
  });
}

export async function getEmergency(id) {
  const e = await getJson(K.emergency(id));
  if (!e) throw new NotFoundError();
  return e;
}

export async function findEmergency(id) {
  return getJson(K.emergency(id));
}

export async function listEmergencies({ activeOnly = false, limit = 50 } = {}) {
  const ids = activeOnly
    ? await safe((c) => c.sMembers(K.activeSet()))
    : (await safe((c) => c.zRange(K.allZset(), 0, -1))).reverse().slice(0, limit);
  const out = [];
  for (const id of ids) {
    const e = await findEmergency(id);
    if (e) out.push(e);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function activeEmergencyForWatch(watchId) {
  const id = await safe((c) => c.get(K.watchActive(watchId)));
  if (!id) return null;
  const e = await findEmergency(id);
  return e && !isTerminal(e.state) ? e : null;
}

// ---------------------------------------------------------------- timeline
export async function addEvent(emergencyId, type, message, data = {}, state) {
  const current = state ?? (await getJson(K.emergency(emergencyId)))?.state ?? null;
  const entry = { ts: now(), type, message, state: current, data };
  await safe((c) => c.rPush(K.events(emergencyId), JSON.stringify(entry)));
  return entry;
}

export async function getTimeline(emergencyId) {
  await getEmergency(emergencyId);
  const raw = await safe((c) => c.lRange(K.events(emergencyId), 0, -1));
  return raw.map((s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ---------------------------------------------------------------- responders per emergency
export async function getEmergencyResponders(emergencyId) {
  const all = await safe((c) => c.hGetAll(K.responders(emergencyId)));
  return Object.values(all).map((s) => JSON.parse(s));
}

export async function saveEmergencyResponder(emergencyId, rec) {
  await safe((c) => c.hSet(K.responders(emergencyId), rec.responderId, JSON.stringify({ ...rec, updatedAt: now() })));
}

export async function getEmergencyResponder(emergencyId, responderId) {
  const raw = await safe((c) => c.hGet(K.responders(emergencyId), responderId));
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------- views
/** Public view: what watch/dashboard/API consumers see. Never contains phone numbers or secrets. */
export function toView(e, responders = []) {
  return {
    id: e.id,
    watchId: e.watchId,
    createdAt: e.createdAt,
    triggerType: e.triggerType,
    priority: e.priority,
    state: e.state,
    summary: e.summary,
    triggerAssessment: e.triggerAssessment ?? null,
    signals: e.signals,
    healthSummary: e.healthSummary,
    motionSummary: e.motionSummary ?? null,
    location: e.location,
    locationShared: Boolean(e.responsibilities?.LOCATION_SHARED?.done),
    assignedResponder: e.assignedResponder,
    responsiblePerson: e.responsiblePerson,
    responsibleRole: e.responsibleRole,
    nextAction: e.nextAction,
    coverage: e.coverage,
    contactStatus: e.contactStatus,
    retryCount: e.retryCount,
    followUp: { ...e.followUp, nextInSeconds: e.followUp?.nextDueAt ? Math.max(0, Math.ceil((e.followUp.nextDueAt - now()) / 1000)) : null },
    countdown: e.countdown && !isTerminal(e.state) ? { kind: e.countdown.kind, label: e.countdown.label, seconds: Math.max(0, Math.ceil((e.countdown.dueAt - now()) / 1000)) } : null,
    nearbyEnabled: e.nearbyEnabled !== false,
    nearbyStage: e.nearbyStage ?? null,
    progress: progressSteps(e),
    recommendedRoles: e.recommendedRoles ?? [],
    aiUsed: Boolean(e.aiUsed),
    demo: Boolean(e.demo),
    acknowledgedBy: e.acknowledgedBy ?? [],
    responders: responders.map((r) => ({ responderId: r.responderId, name: r.name, role: r.role, status: r.status, attempts: r.attempts ?? 0, kind: r.kind ?? 'EXTERNAL', distanceMeters: r.distanceMeters ?? null })),
    lastUpdate: e.lastUpdate,
  };
}

export async function viewOf(id) {
  const e = await getEmergency(id);
  return toView(e, await getEmergencyResponders(id));
}

/** Publish emergency:updated (or a specific event) with the fresh full view. */
export async function broadcast(emergencyId, event = 'emergency:updated', extra = {}) {
  const e = await getEmergency(emergencyId);
  const view = toView(e, await getEmergencyResponders(emergencyId));
  publish(event, { emergency: view, ...extra }, { emergencyId, watchId: e.watchId });
  return view;
}

// ---------------------------------------------------------------- mutation
/**
 * Serialised read-modify-write. `fn(e)` mutates the emergency in place and may return {event:{type,message,data}}.
 * Terminal emergencies reject mutation unless `allowTerminal`.
 */
export async function mutate(id, fn, { allowTerminal = false } = {}) {
  return withLock(`emergency:${id}`, async () => {
    const e = await getEmergency(id);
    if (isTerminal(e.state) && !allowTerminal) return { emergency: e, changed: false, terminal: true };
    const before = e.state;
    const res = (await fn(e)) ?? {};
    await persist(e);
    if (res.event) await addEvent(id, res.event.type, res.event.message, res.event.data ?? {}, e.state);
    if (e.state !== before) emergencyLog('info', e, 'emergency.state_changed', { from: before, to: e.state });
    return { emergency: e, changed: true, terminal: false, result: res };
  });
}

/** Validated state transition. Throws InvalidTransitionError for illegal moves. */
export function applyTransition(e, to) {
  if (e.state === to && to !== 'RESPONDER_SEARCHING') return false;
  if (!canTransition(e.state, to) && !(e.state === to)) throw new InvalidTransitionError(e.state, to);
  e.state = to;
  return true;
}

export async function transition(id, to, { type, message, data, apply } = {}) {
  return mutate(id, (e) => {
    applyTransition(e, to);
    apply?.(e);
    return { event: { type: type ?? `STATE_${to}`, message: message ?? `State changed to ${to}`, data } };
  });
}

export function setResponsible(e, person, role, nextAction) {
  e.responsiblePerson = person;
  e.responsibleRole = role;
  e.nextAction = nextAction;
}

export function markResponsibility(e, key, by) {
  if (!e.responsibilities[key]?.done) e.responsibilities[key] = { done: true, at: now(), by: by ?? null };
}
export function clearResponsibility(e, key) {
  if (e.responsibilities[key]) e.responsibilities[key] = { done: false, at: null, by: null };
}

// ---------------------------------------------------------------- visible countdown + progress checklist
/** A visible "why the next step happens soon" timer (follow-up / nearby wait / retry). Server clock. */
export function setCountdown(e, kind, label, dueAt) {
  e.countdown = { kind, label, dueAt };
}
export function clearCountdown(e) {
  e.countdown = null;
}

/** Ordered checklist for the watch/dashboard: done / current / pending / skipped. */
export function progressSteps(e) {
  const r = e.responsibilities ?? {};
  const done = (k) => Boolean(r[k]?.done);
  const nearby =
    e.nearbyStage === 'DISABLED' ? { label: 'Nearby alerts off (settings)', state: 'skipped' }
    : e.nearbyStage === 'NONE' ? { label: 'No nearby responders available', state: 'skipped' }
    : e.nearbyStage ? { label: 'Nearby responders notified', state: 'done' }
    : { label: 'Nearby responders notified', state: 'pending' };
  const steps = [
    { label: 'Emergency detected', state: 'done' },
    { label: 'Location captured', state: e.location ? 'done' : 'pending' },
    nearby,
    { label: 'Responder accepted', state: done('RESPONDER_ACCEPTED') || done('PERSON_REACHED') ? 'done' : 'pending' },
    { label: 'Responder moving', state: done('RESPONDER_MOVING') || done('PERSON_REACHED') ? 'done' : 'pending' },
    { label: 'Person reached', state: done('PERSON_REACHED') ? 'done' : 'pending' },
    { label: 'Help confirmed', state: done('HELP_CONFIRMED') ? 'done' : 'pending' },
  ];
  const cur = steps.findIndex((x) => x.state === 'pending');
  if (cur >= 0 && !isTerminal(e.state)) steps[cur].state = 'current';
  return steps;
}

// ---------------------------------------------------------------- creation
const COORDINATOR = { person: 'CHER Coordinator', role: 'SYSTEM_COORDINATOR' };
export { COORDINATOR };

function newId() {
  return `E-${crypto.randomUUID()}`;
}

/**
 * Create (idempotently) an emergency. Same emergencyId/eventId => same emergency.
 * A new trigger while the watch already has an active emergency is merged, not duplicated.
 * @returns {{emergency, created:boolean, merged:boolean, duplicate:boolean}}
 */
export async function createEmergency(input) {
  const watchId = input.watchId ?? config.defaultWatchId;
  const eventId = input.eventId ?? input.emergencyId;

  return withLock(`watch:${watchId}:create`, async () => {
    // 1. Idempotency: identical id or eventId returns the existing emergency.
    if (input.emergencyId) {
      const existing = await findEmergency(input.emergencyId);
      if (existing) return { emergency: existing, created: false, merged: false, duplicate: true };
    }
    if (eventId) {
      const first = await claimOnce(K.idem('emergency', eventId), config.limits.idempotencyTtlSeconds);
      if (!first) {
        const mapped = await safe((c) => c.get(K.idem('emergency-id', eventId)));
        const existing = mapped ? await findEmergency(mapped) : null;
        if (existing) return { emergency: existing, created: false, merged: false, duplicate: true };
        // First claimant crashed before writing: fall through and create.
      }
    }

    // 2. Merge into the watch's already-active emergency.
    const active = await activeEmergencyForWatch(watchId);
    if (active) {
      const { emergency } = await mutate(active.id, (e) => {
        for (const s of input.signals ?? []) if (!e.signals.includes(s)) e.signals.push(s);
        const manual = input.triggerType === 'MANUAL_SOS' || input.triggerType === 'USER_NEEDS_HELP';
        if (manual && PRIORITIES.indexOf(e.priority) < PRIORITIES.indexOf('HIGH')) e.priority = 'HIGH';
        return { event: { type: 'TRIGGER_MERGED', message: `Additional trigger received (${input.triggerType}); merged into active emergency`, data: { triggerType: input.triggerType } } };
      });
      if (eventId) await safe((c) => c.set(K.idem('emergency-id', eventId), active.id, { expiration: { type: 'EX', value: config.limits.idempotencyTtlSeconds } }));
      return { emergency, created: false, merged: true, duplicate: false };
    }

    // 3. New emergency.
    const id = input.emergencyId ?? newId();
    const location = input.location
      ? { latitude: input.location.latitude, longitude: input.location.longitude, accuracy: input.location.accuracy ?? null, timestamp: input.location.timestamp ?? now() }
      : await getLatestLocation(watchId).catch(() => null);

    let healthSummary = { bpm: input.health?.bpm ?? null, baselineBpm: input.health?.baselineBpm ?? null, trend: input.health?.trend ?? null, sensorAvailable: input.health?.sensorAvailable ?? null };
    if (healthSummary.bpm == null) {
      const stored = await getHealthSummary(watchId).catch(() => null);
      if (stored) healthSummary = { ...healthSummary, ...Object.fromEntries(Object.entries(stored).filter(([, v]) => v != null)) };
    }

    // Does the wearer allow CHER to alert nearby CHER users? Sent by the watch with the emergency; default ON.
    const nearbyEnabled = input.nearbyAlerts ?? true;
    const signals = [...new Set(input.signals ?? [])];
    const priority = deterministicPriority(input.triggerType, signals, input.userResponse);
    const created = now();
    const e = {
      id,
      watchId,
      eventId: eventId ?? id,
      createdAt: created,
      triggerAt: input.triggeredAt ?? created,
      triggerType: input.triggerType,
      demo: Boolean(input.demo),
      nearbyEnabled,
      nearbyStage: null,
      countdown: null,
      priority,
      state: 'ACTIVE',
      signals,
      userResponse: input.userResponse ?? 'NONE',
      healthSummary,
      motionSummary: input.motion ?? null,
      battery: input.battery ?? null,
      location,
      summary: 'Emergency signal received. Contacting emergency responder.',
      triggerAssessment: null,
      recommendedRoles: [],
      assignedResponder: null,
      responsiblePerson: COORDINATOR.person,
      responsibleRole: COORDINATOR.role,
      nextAction: 'Contact the emergency responder',
      responsibilities: { RECORDED: { done: true, at: created, by: 'CHER' } },
      contactStatus: 'Preparing to contact responder',
      retryCount: 0,
      followUp: { nextDueAt: null, retryCount: 0, lastType: null },
      messages: { callMessage: null, smsMessage: null },
      aiUsed: false,
      acknowledgedBy: [],
      lastUpdate: created,
      coverage: null,
    };
    await persist(e);
    if (eventId) await safe((c) => c.set(K.idem('emergency-id', eventId), id, { expiration: { type: 'EX', value: config.limits.idempotencyTtlSeconds } }));
    await addEvent(id, 'EMERGENCY_CREATED', `Emergency created (${e.triggerType})`, { triggerType: e.triggerType, priority, signals }, 'ACTIVE');
    if (location) await addEvent(id, 'LOCATION_RECEIVED', 'Location received', { ageSeconds: Math.round((created - (location.timestamp ?? created)) / 1000) }, 'ACTIVE');
    else await addEvent(id, 'LOCATION_UNAVAILABLE', 'No location available at creation', {}, 'ACTIVE');
    emergencyLog('info', e, 'emergency.created', { triggerType: e.triggerType, priority, demo: e.demo });
    return { emergency: e, created: true, merged: false, duplicate: false };
  });
}

// ---------------------------------------------------------------- acknowledgements
export async function acknowledge(id, by, responderId) {
  const label = responderId ? `${by}:${responderId}` : by;
  const { emergency } = await mutate(id, (e) => {
    if (!e.acknowledgedBy.includes(label)) e.acknowledgedBy.push(label);
    return { event: { type: 'ACKNOWLEDGED', message: `Acknowledged by ${label}`, data: { by, responderId } } };
  }, { allowTerminal: true });
  await safe((c) => c.hSet(K.acks(id), label, String(now())));
  return emergency;
}
