// The closed loop: contact -> accept -> travel -> reach -> confirm -> resolve, with backup/handoff and follow-ups.
// Every step records WHO is responsible and WHAT happens next. Nothing is abandoned silently, and nothing
// is marked RESOLVED without explicit human confirmation.
import crypto from 'node:crypto';
import { config } from './config.js';
import { K, getJson, setJson, safe, withLock, claimOnce, StoreUnavailableError } from './redis.js';
import { bus, publish } from './events.js';
import { logger, emergencyLog } from './logging.js';
import {
  ApiError, InvalidTransitionError, COORDINATOR, addEvent, applyTransition, broadcast, canTransition, clearResponsibility, createEmergency,
  findEmergency, getEmergency, getEmergencyResponder, getEmergencyResponders, isTerminal, markResponsibility, mutate, saveEmergencyResponder,
  setResponsible, toView, activeEmergencyForWatch, listEmergencies, setCountdown, clearCountdown } from './emergency.js';
import * as scheduler from './scheduler.js';
import * as tw from './twilio.js';
import { analyzeEmergency, aiEnabled } from './ai.js';
import { RESPONDER_ROLES, PRIORITIES } from './validation.js';
import { formatCoordinates } from './location.js';
import { initCallWatcher } from './callWatcher.js';
import { closeNearby, dispatchNearby, helperCheckIn, initNearby, isHelperId } from './nearbyHelpers.js';

export const ROLE_LABEL = {
  FIRST_RESPONDER: 'First Responder',
  EMERGENCY_SERVICES_CALLER: 'Emergency Services Caller',
  AED_RUNNER: 'AED Runner',
  BACKUP_RESPONDER: 'Backup Responder',
  ROUTE_GUIDE: 'Route Guide',
  TRANSPORT_SUPPORT: 'Transport Support',
};
/** Human-readable role: a phone contact acting as first responder is an "Emergency Contact". */
const roleLabel = (rec) => (rec.role === 'FIRST_RESPONDER' && !isHelperId(rec.responderId) ? 'Emergency Contact' : ROLE_LABEL[rec.role]);
const ACTIVE_RESP = ['ACCEPTED', 'MOVING', 'REACHED'];
const PRE_ACCEPT_DEAD = ['DECLINED', 'NO_RESPONSE', 'UNRESPONSIVE'];
const MANUAL = new Set(['MANUAL_SOS', 'USER_NEEDS_HELP']);

// A re-called contact gets an alias id like "R1.b1" so its per-emergency record does not overwrite the first one.
const baseId = (id) => String(id).split('.')[0];
const contactOf = (id) => config.contacts.find((c) => c.id === baseId(id));
const requireContact = (id) => {
  const c = contactOf(id);
  if (!c) throw new ApiError(404, 'RESPONDER_NOT_FOUND', `Unknown responder ${id}`);
  return c;
};
const maxRetries = () => config.twilio.maxRetries;
// DEMO timing lives in config.timing (CHER_DEMO_MODE=true => short gaps); production keeps the normal intervals.
const retryMs = () => config.timing.retrySeconds() * 1000;
/** Gap before the next follow-up. Demo mode ignores the AI-suggested value so the demo timing is predictable. */
const followSeconds = (e) => (config.demoMode ? config.timing.followUpSeconds() : (e?.followUp?.intervalSeconds ?? config.followUp.intervalSeconds));
/** Show WHY the next step will happen soon (rendered as a countdown on the watch/dashboard). */
async function showCountdown(id, kind, label, dueAt) {
  await mutate(id, (em) => {
    setCountdown(em, kind, label, dueAt);
  });
}
const shortUuid = () => crypto.randomUUID().slice(0, 8);
const bg = (label, p) => p.catch((err) => logger.error('chain.background_failed', { label, message: err?.message }));

// ------------------------------------------------------------------ responder registry (Redis)
export async function initResponders() {
  for (const c of config.contacts) {
    const existing = await getJson(K.responder(c.id));
    await setJson(K.responder(c.id), { id: c.id, name: c.name, status: existing?.status ?? 'AVAILABLE', order: c.priorityOrder, lastSeen: existing?.lastSeen ?? null });
    await safe((r) => r.sAdd(K.responderSet(), c.id));
  }
}

export async function listResponders() {
  const out = [];
  for (const c of config.contacts) {
    const rec = (await getJson(K.responder(c.id))) ?? { id: c.id, name: c.name, status: 'AVAILABLE', order: c.priorityOrder };
    out.push({ id: c.id, name: c.name, status: rec.status, order: c.priorityOrder, lastSeen: rec.lastSeen ?? null });
  }
  return out;
}

export async function setResponderStatus(id, status) {
  const c = requireContact(id);
  const rec = { id, name: c.name, status, order: c.priorityOrder, lastSeen: Date.now() };
  await setJson(K.responder(id), rec);
  publish('responder:status', { responder: rec });
  return rec;
}

const globallyUnavailable = async (id) => ((await getJson(K.responder(baseId(id))))?.status ?? 'AVAILABLE') === 'UNAVAILABLE';

// ------------------------------------------------------------------ entry: trigger
const degradedSeen = new Set();
/** Redis is down: still try to alert the primary contact by SMS so a life-safety event is not silently lost. */
async function degradedNotify(input) {
  const contact = config.contacts[0];
  const key = input.eventId ?? input.emergencyId ?? `${input.watchId}:${input.triggerType}`;
  if (!contact || degradedSeen.has(key)) return false;
  degradedSeen.add(key);
  const loc = input.location ? formatCoordinates(input.location) : 'unavailable';
  const res = await tw.sendSms({ to: contact.phone, body: `CHER emergency (degraded mode). A person may need assistance. Location: ${loc}. CHER could not record this event; please try to reach them.`, purpose: 'DEGRADED' });
  logger.error('chain.degraded_notify', { notified: res.ok });
  return res.ok;
}

/**
 * Create an emergency (idempotently) and start the response chain.
 * Returns right after creation. `started` resolves once the first outreach is initiated; `analysis` once the
 * AI/fallback analysis has been applied (for manual SOS that can finish AFTER outreach began).
 */
export async function triggerEmergency(input) {
  let res;
  try {
    res = await createEmergency(input);
  } catch (err) {
    if (err instanceof StoreUnavailableError || err?.code === 'STORE_UNAVAILABLE') await degradedNotify(input);
    throw err;
  }
  const { emergency, created, merged, duplicate } = res;
  let started = Promise.resolve();
  let analysis = Promise.resolve();
  if (created) {
    await broadcast(emergency.id, 'emergency:created');
    const run = bg('startResponse', startResponse(emergency.id));
    started = run.then(() => undefined); // first outreach initiated
    analysis = run.then((r) => r?.analysis); // AI/fallback analysis applied
  } else if (merged) {
    await broadcast(emergency.id, 'emergency:updated');
  }
  const view = toView(await getEmergency(emergency.id), await getEmergencyResponders(emergency.id));
  return { emergency: view, created, merged, duplicate, started, analysis };
}

const VERIFIED_BY = {
  MANUAL_SOS: 'Emergency verified: the wearer pressed SOS',
  USER_NEEDS_HELP: 'Emergency verified: the wearer asked for help',
  AUTO_FALL_NO_RESPONSE: 'Emergency verified: possible fall and no reply to "Are you OK?"',
  AUTO_MULTI_SIGNAL: 'Emergency verified: several signals and no reply to "Are you OK?"',
  AUTO_HEART_RATE_ANOMALY: 'Emergency verified: unusual heart-rate pattern and no reply to "Are you OK?"',
  AUTO_INACTIVITY: 'Emergency verified: prolonged inactivity and no reply to "Are you OK?"',
};

async function startResponse(id) {
  const e0 = await getEmergency(id);
  await mutate(id, (e) => {
    applyTransition(e, 'RESPONDER_SEARCHING');
    e.contactStatus = 'Searching for responder';
    return { event: { type: 'RESPONSE_STARTED', message: 'Response chain started' } };
  });
  await addEvent(id, 'EMERGENCY_VERIFIED', VERIFIED_BY[e0.triggerType] ?? 'Emergency verified', { triggerType: e0.triggerType });
  await broadcast(id);
  // Manual SOS never waits for AI: outreach starts immediately, analysis enriches it in parallel.
  const analysis = bg('analysis', runAnalysis(id, 'INITIAL'));
  if (!MANUAL.has(e0.triggerType)) await analysis;
  // Nearby CHER watches get a pop-up first; phone contacts are only called if nobody nearby takes it (see nearby.js).
  let alerted = 0;
  try {
    alerted = (await dispatchNearby(id)).alerted;
  } catch (err) {
    logger.error('chain.nearby_failed', { message: err?.message }); // never let this block the contact chain
  }
  if (alerted === 0) await contactNextResponder(id, { reason: 'initial' });
  return { analysis };
}

// ------------------------------------------------------------------ AI analysis
export async function runAnalysis(id, mode = 'INITIAL') {
  if (mode === 'REPLAN' && !aiEnabled()) return null;
  const { output, source, error } = await analyzeEmergency(id, makeActions(id, mode), { mode });
  await mutate(id, (e) => {
    if (PRIORITIES.indexOf(output.priority) > PRIORITIES.indexOf(e.priority)) e.priority = output.priority;
    e.summary = output.summary;
    e.triggerAssessment = output.triggerAssessment;
    e.aiUsed = e.aiUsed || source === 'AI';
    if (mode === 'INITIAL') e.messages = { callMessage: output.callMessage, smsMessage: output.smsMessage };
    e.recommendedRoles = output.recommendedRoles.filter((r) => RESPONDER_ROLES.includes(r.role));
    e.aiNextAction = output.nextAction;
    e.followUp.intervalSeconds = output.followUpSeconds;
    return {
      event: {
        type: 'AI_ANALYZED',
        message: source === 'AI' ? 'AI coordinator analyzed emergency' : `Deterministic coordinator analysis (${error ?? 'fallback'})`,
        data: { source, priority: output.priority, needsBackup: output.needsBackup },
      },
    };
  });
  await broadcast(id);
  return output;
}

// ------------------------------------------------------------------ outreach
async function markUnconfirmed(id, reason, { force = false } = {}) {
  const records = await getEmergencyResponders(id);
  const { emergency, result } = await mutate(id, (e) => {
    const engaged = records.some((r) => ACTIVE_RESP.includes(r.status));
    if (!force && engaged && e.state !== 'RESPONDER_NEEDS_BACKUP') {
      setResponsible(e, e.responsiblePerson, e.responsibleRole, 'No additional responder available: call local emergency services if help is needed');
      e.contactStatus = 'No backup available';
      return { event: { type: 'NO_BACKUP_AVAILABLE', message: `No further responder available (${reason})` }, unconfirmed: false };
    }
    if (!canTransition(e.state, 'UNCONFIRMED')) return { unconfirmed: false };
    applyTransition(e, 'UNCONFIRMED');
    setResponsible(e, COORDINATOR.person, COORDINATOR.role, 'No responder confirmed. Call local emergency services or check on the person directly.');
    e.contactStatus = 'No responder confirmed';
    return { event: { type: 'UNCONFIRMED', message: `Emergency UNCONFIRMED: ${reason}` }, unconfirmed: true };
  });
  if (result?.unconfirmed) {
    emergencyLog('warn', emergency, 'emergency.unconfirmed', { reason });
    await broadcast(id, 'response:unconfirmed', { reason });
    if (await claimOnce(K.idem('unconfirmed-sms', id), 3600)) {
      for (const c of config.contacts) {
        const sms = await tw.sendSms({ to: c.phone, body: `CHER #${tw.shortId(id)}: no responder has confirmed. If you can, please check on the person or call local emergency services.`, emergencyId: id, responderId: c.id, watchId: emergency.watchId, purpose: 'UNCONFIRMED' });
        await addEvent(id, sms.ok ? 'SMS_SENT' : 'SMS_FAILED', `Unconfirmed notice to ${c.name}`, { simulated: sms.simulated });
      }
    }
  } else {
    await broadcast(id);
  }
  return Boolean(result?.unconfirmed);
}

/** Pick the next eligible configured contact (never re-using one already tried in this emergency) and contact them. */
export async function contactNextResponder(id, { reason = 'next', role } = {}) {
  const picked = await withLock(`chain:${id}`, async () => {
    const e = await findEmergency(id);
    if (!e || isTerminal(e.state)) return { terminal: true };
    const records = await getEmergencyResponders(id);
    for (const c of config.contacts) {
      if (records.some((r) => r.responderId === c.id)) continue;
      if (await globallyUnavailable(c.id)) continue;
      const assignedRole = role ?? (records.some((r) => ACTIVE_RESP.includes(r.status) || r.status === 'NEEDS_BACKUP') ? 'BACKUP_RESPONDER' : 'FIRST_RESPONDER');
      const rec = { responderId: c.id, name: c.name, role: assignedRole, status: 'CONTACTING', attempts: 0, pendingAttempt: null, createdAt: Date.now() };
      await saveEmergencyResponder(id, rec);
      await mutate(id, (em) => {
        if (canTransition(em.state, 'RESPONDER_SEARCHING')) em.state = 'RESPONDER_SEARCHING';
        if (em.state === 'RESPONDER_SEARCHING') setResponsible(em, COORDINATOR.person, COORDINATOR.role, `Contact ${c.name} and wait for an answer`);
        em.contactStatus = `Contacting ${c.name}`;
        return { event: { type: 'RESPONDER_ASSIGNED', message: `${c.name} selected as ${ROLE_LABEL[assignedRole]} (${reason})`, data: { responderId: c.id, role: assignedRole, reason } } };
      });
      return { responderId: c.id, role: assignedRole, name: c.name };
    }
    // Single-contact setups: re-call the same person once as the backup (never after a decline or no-answer).
    if (config.reuseSingleContact && ['backup', 'followup-exhausted'].includes(reason)) {
      for (const c of config.contacts) {
        if (records.filter((r) => baseId(r.responderId) === c.id).length !== 1) continue;
        if (await globallyUnavailable(c.id)) continue;
        const aliasId = `${c.id}.b1`;
        const rec = { responderId: aliasId, name: c.name, role: 'BACKUP_RESPONDER', status: 'CONTACTING', attempts: 0, pendingAttempt: null, createdAt: Date.now() };
        await saveEmergencyResponder(id, rec);
        await mutate(id, (em) => {
          if (canTransition(em.state, 'RESPONDER_SEARCHING')) em.state = 'RESPONDER_SEARCHING';
          if (em.state === 'RESPONDER_SEARCHING') setResponsible(em, COORDINATOR.person, COORDINATOR.role, `Contact ${c.name} again as backup`);
          em.contactStatus = `Contacting ${c.name} again (backup)`;
          return { event: { type: 'RESPONDER_ASSIGNED', message: `Only one contact configured: re-contacting ${c.name} as backup (${reason})`, data: { responderId: aliasId, role: 'BACKUP_RESPONDER', reason } } };
        });
        return { responderId: aliasId, role: 'BACKUP_RESPONDER', name: c.name };
      }
    }
    return { none: true };
  });
  if (picked.terminal) return null;
  if (picked.none) {
    await markUnconfirmed(id, `no responder available (${reason})`, { force: reason === 'backup' || reason === 'followup-exhausted' });
    return null;
  }
  await broadcast(id, 'response:assigned', { responderId: picked.responderId, role: picked.role, reason });
  await attemptContact(id, picked.responderId);
  return picked;
}

/** One outreach attempt (SMS on the first, call on every attempt). Idempotent per attempt. */
export async function attemptContact(id, responderId) {
  const contact = requireContact(responderId);
  const outcome = await withLock(`resp:${id}:${responderId}`, async () => {
    const e = await findEmergency(id);
    const rec = await getEmergencyResponder(id, responderId);
    if (!e || isTerminal(e.state) || !rec || rec.status !== 'CONTACTING' || rec.pendingAttempt) return null;
    rec.attempts += 1;
    rec.lastAttemptAt = Date.now();
    const attemptId = shortUuid();
    const cid = await tw.createCallRecord({ emergencyId: id, responderId, purpose: 'INITIAL', attemptId });
    rec.pendingAttempt = { attemptId, cid, startedAt: rec.lastAttemptAt };
    await saveEmergencyResponder(id, rec);
    return { e, rec, attemptId, cid };
  });
  if (!outcome) return false;
  const { e, rec, attemptId, cid } = outcome;
  const total = (await getEmergencyResponders(id)).reduce((a, r) => a + (r.attempts ?? 0), 0);

  await mutate(id, (em) => {
    em.retryCount = total;
    em.contactStatus = `Calling ${contact.name}... (attempt ${rec.attempts}/${maxRetries()})`;
    return { event: { type: 'CONTACT_ATTEMPT', message: `Contacting ${contact.name} (attempt ${rec.attempts}/${maxRetries()})`, data: { responderId, attempt: rec.attempts } } };
  });

  let sent = { ok: false, error: 'invalid phone' };
  if (rec.attempts === 1) {
    const body = tw.composeSms(e);
    sent = contact.phoneValid || tw.isSimulated() ? await tw.sendSms({ to: contact.phone, body, emergencyId: id, responderId, watchId: e.watchId, purpose: 'INITIAL' }) : sent;
    await mutate(id, (em) => {
      return { event: { type: sent.ok ? 'SMS_SENT' : 'SMS_FAILED', message: sent.ok ? `Emergency SMS sent to ${contact.name}${sent.simulated ? ' (simulated)' : ''}` : `Emergency SMS to ${contact.name} failed`, data: { error: sent.error } } };
    });
  }

  const call = contact.phoneValid || tw.isSimulated() ? await tw.startCall({ to: contact.phone, cid, kind: 'INITIAL', emergencyId: id, responderId, watchId: e.watchId }) : { ok: false, error: 'invalid phone number' };
  await mutate(id, (em) => ({ event: { type: call.ok ? 'CALL_STARTED' : 'CALL_FAILED', message: call.ok ? `Call started to ${contact.name}${call.simulated ? ' (simulated)' : ''}` : `Call to ${contact.name} failed`, data: { responderId, error: call.error } } }));

  await scheduler.schedule({ emergencyId: id, responderId, type: 'OUTREACH_TIMEOUT', dueAt: rec.lastAttemptAt + retryMs(), retryCount: rec.attempts, meta: { attemptId } });
  await showCountdown(id, 'RETRY', `Waiting for ${contact.name} to answer`, rec.lastAttemptAt + retryMs());
  await broadcast(id);
  if (!call.ok && !sent.ok) await handleAttemptFailure(id, responderId, attemptId, 'CONTACT_FAILED');
  return true;
}

/** An outreach attempt ended without an answer: retry per policy, else hand off to the next responder. */
export async function handleAttemptFailure(id, responderId, attemptId, reason) {
  const next = await withLock(`resp:${id}:${responderId}`, async () => {
    const e = await findEmergency(id);
    const rec = await getEmergencyResponder(id, responderId);
    if (!e || isTerminal(e.state) || !rec || rec.status !== 'CONTACTING' || rec.pendingAttempt?.attemptId !== attemptId) return { ignored: true };
    rec.pendingAttempt = null;
    await scheduler.cancel(id, (it) => it.type === 'OUTREACH_TIMEOUT' && it.meta?.attemptId === attemptId);
    if (rec.attempts < maxRetries()) {
      await saveEmergencyResponder(id, rec);
      const dueAt = Math.max(Date.now(), rec.lastAttemptAt + retryMs());
      await scheduler.schedule({ emergencyId: id, responderId, type: 'OUTREACH_RETRY', dueAt, retryCount: rec.attempts });
      return { retry: true, name: rec.name, attempts: rec.attempts, dueAt };
    }
    rec.status = 'NO_RESPONSE';
    await saveEmergencyResponder(id, rec);
    return { exhausted: true, name: rec.name };
  });
  if (next.ignored) return false;
  if (next.retry) {
    await mutate(id, (em) => {
      const inS = Math.max(0, Math.round((next.dueAt - Date.now()) / 1000));
      const failed = reason === 'CONTACT_FAILED';
      setCountdown(em, 'RETRY', 'Retrying call', next.dueAt);
      em.contactStatus = failed ? `Could not place call to ${next.name} (phone service error). Retrying in ${inS}s` : `No answer from ${next.name}. Retrying in ${inS}s`;
      return { event: { type: failed ? 'CONTACT_FAILED' : 'RESPONDER_NO_ANSWER', message: failed ? `Call and SMS to ${next.name} could not be sent; retry scheduled` : `No answer from ${next.name} (${reason}); retry scheduled`, data: { responderId, attempt: next.attempts, reason } } };
    });
    await broadcast(id);
    return true;
  }
  await mutate(id, () => ({ event: { type: 'RESPONDER_TIMEOUT', message: `${next.name} did not respond after ${maxRetries()} attempts`, data: { responderId } } }));
  await contactNextResponder(id, { reason: 'timeout' });
  return true;
}

// ------------------------------------------------------------------ responder decisions
async function ensureRecord(id, responderId) {
  const existing = await getEmergencyResponder(id, responderId);
  if (existing && isHelperId(responderId)) return existing; // nearby helpers get their record when alerted
  const c = requireContact(responderId);
  return existing ?? { responderId, name: c.name, role: 'FIRST_RESPONDER', status: 'NONE', attempts: 0, pendingAttempt: null };
}

async function requireActive(id) {
  const e = await getEmergency(id);
  if (isTerminal(e.state)) throw new InvalidTransitionError(e.state, 'ACTIVE');
  return e;
}

/** Backend-side validation of a role assignment. */
function validateRole(role, records, responderId) {
  const wanted = RESPONDER_ROLES.includes(role) ? role : 'FIRST_RESPONDER';
  if (wanted === 'FIRST_RESPONDER' && records.some((r) => r.responderId !== responderId && r.role === 'FIRST_RESPONDER' && ACTIVE_RESP.includes(r.status))) return 'BACKUP_RESPONDER';
  return wanted;
}

export async function responderAccepts(id, responderId, { role, via = 'API' } = {}) {
  const e0 = await requireActive(id);
  const result = await withLock(`resp:${id}:${responderId}`, async () => {
    const rec = await ensureRecord(id, responderId);
    if (ACTIVE_RESP.includes(rec.status) || rec.status === 'NEEDS_BACKUP') return { duplicate: true };
    const records = await getEmergencyResponders(id);
    rec.role = validateRole(role ?? rec.role, records, responderId);
    rec.status = 'ACCEPTED';
    rec.acceptedAt = Date.now();
    rec.pendingAttempt = null;
    await saveEmergencyResponder(id, rec);
    await scheduler.cancel(id, (it) => it.responderId === responderId && it.type.startsWith('OUTREACH'));
    return { rec };
  });
  if (result.duplicate) return { duplicate: true, emergency: await viewFor(id) };
  const { rec } = result;
  const followSecs = followSeconds(e0);

  await mutate(id, (e) => {
    markResponsibility(e, 'CONTACT_ATTEMPTED', 'CHER');
    markResponsibility(e, 'RESPONDER_ACCEPTED', rec.responderId);
    if (!['FIRST_RESPONDER', 'BACKUP_RESPONDER'].includes(rec.role)) markResponsibility(e, `ROLE:${rec.role}`, rec.responderId);
    const advance = canTransition(e.state, 'RESPONDER_ACCEPTED');
    if (advance) e.state = 'RESPONDER_ACCEPTED';
    if (advance || !e.assignedResponder) {
      e.assignedResponder = { id: rec.responderId, name: rec.name, role: rec.role, status: 'ACCEPTED' };
      setResponsible(e, rec.name, roleLabel(rec), e.aiNextAction ?? 'Reach the reported location');
    }
    e.contactStatus = `${rec.name} accepted`;
    clearCountdown(e);
    e.followUp.retryCount = 0;
    return { event: { type: 'RESPONDER_ACCEPTED', message: `${rec.name} accepted as ${roleLabel(rec)} (${via})`, data: { responderId, role: rec.role, via } } };
  });

  await sendLocationSms(id, responderId, { update: true });
  await scheduleStatusFollowUp(id, responderId, followSecs);
  await broadcast(id, 'response:accepted', { responderId, role: rec.role });
  await broadcast(id);
  return { emergency: await viewFor(id) };
}

export async function responderDeclines(id, responderId, { via = 'API' } = {}) {
  await requireActive(id);
  const result = await withLock(`resp:${id}:${responderId}`, async () => {
    const rec = await ensureRecord(id, responderId);
    if (ACTIVE_RESP.includes(rec.status) || PRE_ACCEPT_DEAD.includes(rec.status)) return { ignored: true };
    rec.status = 'DECLINED';
    rec.pendingAttempt = null;
    await saveEmergencyResponder(id, rec);
    await scheduler.cancel(id, (it) => it.responderId === responderId && it.type.startsWith('OUTREACH'));
    return { rec };
  });
  if (result.ignored) return { ignored: true, emergency: await viewFor(id) };
  await mutate(id, () => ({ event: { type: 'RESPONDER_DECLINED', message: `${result.rec.name} cannot help (${via})`, data: { responderId } } }));
  await broadcast(id, 'response:declined', { responderId });
  await contactNextResponder(id, { reason: 'declined' });
  return { emergency: await viewFor(id) };
}

async function ensureAccepted(id, responderId) {
  const rec = await ensureRecord(id, responderId);
  if (!ACTIVE_RESP.includes(rec.status) && rec.status !== 'NEEDS_BACKUP') await responderAccepts(id, responderId, { via: 'IMPLICIT' });
  return getEmergencyResponder(id, responderId);
}

export async function responderMoving(id, responderId, { via = 'API' } = {}) {
  await requireActive(id);
  await ensureAccepted(id, responderId);
  const rec = await withLock(`resp:${id}:${responderId}`, async () => {
    const r = await getEmergencyResponder(id, responderId);
    if (r.status === 'MOVING' || r.status === 'REACHED') return null;
    r.status = 'MOVING';
    await saveEmergencyResponder(id, r);
    return r;
  });
  if (!rec) return { duplicate: true, emergency: await viewFor(id) };
  await mutate(id, (e) => {
    markResponsibility(e, 'RESPONDER_MOVING', responderId);
    if (canTransition(e.state, 'RESPONDER_MOVING')) {
      e.state = 'RESPONDER_MOVING';
      e.assignedResponder = { id: responderId, name: rec.name, role: rec.role, status: 'MOVING' };
      setResponsible(e, rec.name, roleLabel(rec), 'Continue to the reported location and confirm when you reach the person');
    }
    e.contactStatus = `${rec.name} is on the way`;
    e.followUp.retryCount = 0;
    return { event: { type: 'RESPONDER_MOVING', message: `${rec.name} is moving to the location (${via})`, data: { responderId } } };
  });
  await scheduleStatusFollowUp(id, responderId);
  await broadcast(id, 'response:moving', { responderId });
  await broadcast(id);
  return { emergency: await viewFor(id) };
}

export async function responderReached(id, responderId, { via = 'API' } = {}) {
  await requireActive(id);
  await ensureAccepted(id, responderId);
  const rec = await withLock(`resp:${id}:${responderId}`, async () => {
    const r = await getEmergencyResponder(id, responderId);
    if (r.status === 'REACHED') return null;
    r.status = 'REACHED';
    await saveEmergencyResponder(id, r);
    return r;
  });
  if (!rec) return { duplicate: true, emergency: await viewFor(id) };
  await scheduler.cancel(id, (it) => it.type === 'FOLLOWUP_STATUS' || it.type === 'FOLLOWUP_TIMEOUT');
  await mutate(id, (e) => {
    if (!canTransition(e.state, 'PERSON_REACHED') && e.state !== 'PERSON_REACHED') throw new InvalidTransitionError(e.state, 'PERSON_REACHED');
    markResponsibility(e, 'RESPONDER_ACCEPTED', responderId);
    markResponsibility(e, 'RESPONDER_MOVING', responderId);
    markResponsibility(e, 'PERSON_REACHED', responderId);
    e.state = 'PERSON_REACHED';
    e.assignedResponder = { id: responderId, name: rec.name, role: rec.role, status: 'REACHED' };
    setResponsible(e, rec.name, roleLabel(rec), "Confirm the person's condition and that help is complete");
    e.contactStatus = `${rec.name} reached the person`;
    e.followUp.retryCount = 0;
    return { event: { type: 'PERSON_REACHED', message: `${rec.name} reached the person (${via})`, data: { responderId } } };
  });
  const confirmItem = await scheduler.schedule({ emergencyId: id, responderId, type: 'FOLLOWUP_CONFIRM', delaySeconds: followSeconds(await getEmergency(id)) });
  await showCountdown(id, 'FOLLOWUP', 'Confirmation call', confirmItem.dueAt);
  await broadcast(id, 'response:reached', { responderId });
  await broadcast(id);
  return { emergency: await viewFor(id) };
}

export async function responderNeedsBackup(id, responderId, { reason = 'Responder requested backup', via = 'API' } = {}) {
  await requireActive(id);
  if (responderId) await ensureAccepted(id, responderId);
  const rec = responderId ? await getEmergencyResponder(id, responderId) : null;
  if (rec) {
    rec.status = 'NEEDS_BACKUP';
    await saveEmergencyResponder(id, rec);
  }
  await scheduler.cancel(id, (it) => it.type.startsWith('FOLLOWUP'));
  await mutate(id, (e) => {
    if (e.state !== 'RESPONDER_NEEDS_BACKUP') {
      if (!canTransition(e.state, 'RESPONDER_NEEDS_BACKUP')) throw new InvalidTransitionError(e.state, 'RESPONDER_NEEDS_BACKUP');
      e.state = 'RESPONDER_NEEDS_BACKUP';
    }
    clearResponsibility(e, 'RESPONDER_ACCEPTED');
    clearResponsibility(e, 'RESPONDER_MOVING');
    setResponsible(e, COORDINATOR.person, COORDINATOR.role, 'Find a backup responder');
    e.contactStatus = 'Backup requested';
    return { event: { type: 'BACKUP_REQUESTED', message: `Backup requested${rec ? ` by ${rec.name}` : ''}: ${reason}`, data: { responderId, reason, via } } };
  });
  await broadcast(id, 'response:backup', { responderId, reason });
  const picked = await contactNextResponder(id, { reason: 'backup', role: 'BACKUP_RESPONDER' });
  if (rec && picked) await scheduleStatusFollowUp(id, responderId); // original responder stays in the loop
  if (picked && aiEnabled()) bg('replan', runAnalysis(id, 'REPLAN'));
  return { emergency: await viewFor(id) };
}

export async function helpConfirmed(id, confirmedBy) {
  await requireActive(id);
  const e = await getEmergency(id);
  if (e.state === 'HELP_CONFIRMED') return { duplicate: true, emergency: await viewFor(id) };
  await scheduler.cancel(id, (it) => it.type.startsWith('FOLLOWUP'));
  await mutate(id, (em) => {
    if (!canTransition(em.state, 'HELP_CONFIRMED')) throw new InvalidTransitionError(em.state, 'HELP_CONFIRMED');
    em.state = 'HELP_CONFIRMED';
    markResponsibility(em, 'HELP_CONFIRMED', confirmedBy);
    em.helpConfirmedBy = confirmedBy;
    setResponsible(em, em.responsiblePerson, em.responsibleRole, 'Explicitly close the emergency once the person is confirmed safe');
    em.contactStatus = 'Help confirmed';
    return { event: { type: 'HELP_CONFIRMED', message: `Help explicitly confirmed by ${confirmedBy}`, data: { confirmedBy } } };
  });
  await broadcast(id);
  return { emergency: await viewFor(id) };
}

/** Resolution needs explicit confirmation, and is only reachable from PERSON_REACHED / HELP_CONFIRMED. */
export async function resolveEmergency(id, { confirmedBy, note } = {}) {
  const e = await getEmergency(id);
  if (e.state === 'RESOLVED') return { duplicate: true, emergency: await viewFor(id) };
  if (!['PERSON_REACHED', 'HELP_CONFIRMED'].includes(e.state)) {
    throw new ApiError(409, 'RESOLUTION_REFUSED', `Cannot resolve from ${e.state}: the person must be reached and help explicitly confirmed first`);
  }
  if (e.state === 'PERSON_REACHED') await helpConfirmed(id, confirmedBy); // an explicit resolve request is explicit confirmation
  await scheduler.cancel(id, () => true);
  const { emergency } = await mutate(id, (em) => {
    applyTransition(em, 'RESOLVED');
    em.resolvedAt = Date.now();
    setResponsible(em, em.responsiblePerson, em.responsibleRole, 'None: emergency resolved');
    em.nextAction = 'None: emergency resolved';
    em.contactStatus = 'Resolved';
    return { event: { type: 'RESOLVED', message: `Emergency resolved (confirmed by ${confirmedBy})${note ? `: ${note}` : ''}`, data: { confirmedBy, note } } };
  });
  emergencyLog('info', emergency, 'emergency.resolved', { confirmedBy });
  await broadcast(id, 'emergency:resolved');
  await closeNearby(id, 'RESOLVED', 'The emergency is resolved. Thank you for helping!');
  await notifyResponders(id, 'CHER: this emergency has been resolved. Thank you for helping.');
  return { emergency: await viewFor(id) };
}

export async function cancelEmergency(id, { reason = 'Cancelled', cancelledBy = 'PERSON' } = {}) {
  const e = await getEmergency(id);
  if (e.state === 'CANCELLED') return { duplicate: true, emergency: await viewFor(id) };
  if (isTerminal(e.state)) throw new InvalidTransitionError(e.state, 'CANCELLED');
  await scheduler.cancel(id, () => true);
  const { emergency } = await mutate(id, (em) => {
    applyTransition(em, 'CANCELLED');
    setResponsible(em, em.responsiblePerson, em.responsibleRole, 'None: emergency cancelled');
    em.contactStatus = 'Cancelled';
    return { event: { type: 'CANCELLED', message: `Emergency cancelled by ${cancelledBy}: ${reason}`, data: { reason, cancelledBy } } };
  });
  emergencyLog('info', emergency, 'emergency.cancelled', { cancelledBy });
  await broadcast(id, 'emergency:cancelled');
  await closeNearby(id, 'CANCELLED', 'The person cancelled. No action needed.');
  await notifyResponders(id, 'CHER: this emergency was cancelled by the person. No action needed.');
  return { emergency: await viewFor(id) };
}

async function notifyResponders(id, body) {
  const e = await findEmergency(id);
  for (const r of await getEmergencyResponders(id)) {
    if (!['ACCEPTED', 'MOVING', 'REACHED', 'CONTACTING', 'NEEDS_BACKUP'].includes(r.status)) continue;
    const c = contactOf(r.responderId);
    if (c) await tw.sendSms({ to: c.phone, body: `${body} (#${tw.shortId(id)})`, emergencyId: id, responderId: r.responderId, watchId: e?.watchId, purpose: 'CLOSE' });
  }
}

/** The location was delivered another way (read aloud on the call) because SMS could not be sent. */
export async function markLocationDelivered(id, responderId, via) {
  const { emergency } = await mutate(id, (em) => {
    if (!em.location) return {};
    markResponsibility(em, 'LOCATION_SHARED', via);
    em.locationSharedTs = em.location.timestamp;
    return { event: { type: 'LOCATION_SPOKEN', message: `Location read aloud to ${contactOf(responderId)?.name ?? 'responder'} on the call`, data: { via } } };
  });
  await broadcast(id);
  return emergency;
}

const viewFor = async (id) => toView(await getEmergency(id), await getEmergencyResponders(id));

async function sendLocationSms(id, responderId, { update }) {
  const e = await getEmergency(id);
  const c = contactOf(responderId);
  if (!c) return false;
  const res = await tw.sendSms({ to: c.phone, body: tw.composeSms(e, { update }), emergencyId: id, responderId, watchId: e.watchId, purpose: 'LOCATION' });
  await mutate(id, (em) => {
    if (res.ok && em.location) {
      markResponsibility(em, 'LOCATION_SHARED', 'SMS');
      em.locationSharedTs = em.location.timestamp;
    }
    return { event: { type: res.ok ? 'LOCATION_SMS_SENT' : 'SMS_FAILED', message: res.ok ? `Location SMS sent to ${c.name}${res.simulated ? ' (simulated)' : ''}` : `Location SMS to ${c.name} failed`, data: { error: res.error } } };
  });
  return res.ok;
}

// ------------------------------------------------------------------ follow-ups
async function scheduleStatusFollowUp(id, responderId, seconds) {
  const e = await getEmergency(id);
  await scheduler.cancel(id, (it) => it.type === 'FOLLOWUP_STATUS' && it.responderId === responderId);
  const delay = config.demoMode ? config.timing.followUpSeconds() : (seconds ?? followSeconds(e));
  const item = await scheduler.schedule({ emergencyId: id, responderId, type: 'FOLLOWUP_STATUS', delaySeconds: delay });
  await mutate(id, (em) => {
    em.followUp.nextDueAt = item.dueAt;
    setCountdown(em, 'FOLLOWUP', 'Next follow-up call', item.dueAt);
    return { event: { type: 'FOLLOWUP_SCHEDULED', message: `Follow-up scheduled in ${delay}s`, data: { responderId, dueAt: item.dueAt } } };
  });
  return item;
}

async function runFollowUp(item) {
  const id = item.emergencyId;
  const e = await findEmergency(id);
  if (!e || isTerminal(e.state)) return;
  const type = item.type === 'FOLLOWUP_CONFIRM' ? 'CONFIRM' : 'STATUS';
  if (type === 'CONFIRM' && e.state !== 'PERSON_REACHED') return;
  if (type === 'STATUS' && ['PERSON_REACHED', 'HELP_CONFIRMED'].includes(e.state)) return;
  const rec = await getEmergencyResponder(id, item.responderId);
  if (rec && isHelperId(item.responderId)) return ACTIVE_RESP.includes(rec.status) ? helperCheckIn(e, rec, item, type) : undefined; // check-in on their watch, no phone call
  const contact = contactOf(item.responderId);
  if (!rec || !contact || !ACTIVE_RESP.includes(rec.status)) return;

  if (e.location && (e.locationSharedTs ?? 0) < e.location.timestamp - 30_000) await sendLocationSms(id, item.responderId, { update: true });

  const cid = await tw.createCallRecord({ emergencyId: id, responderId: item.responderId, purpose: 'FOLLOWUP', followUpType: type, itemId: item.id });
  const call = contact.phoneValid || tw.isSimulated() ? await tw.startCall({ to: contact.phone, cid, kind: 'FOLLOWUP', followUpType: type, emergencyId: id, responderId: item.responderId, watchId: e.watchId }) : { ok: false, error: 'invalid phone number' };
  await mutate(id, (em) => {
    em.followUp.lastType = type;
    em.contactStatus = `Follow-up call to ${contact.name}`;
    return { event: { type: call.ok ? 'FOLLOWUP_STARTED' : 'FOLLOWUP_CALL_FAILED', message: `Follow-up (${type}) ${call.ok ? 'call started' : 'call failed'} for ${contact.name}${call.simulated ? ' (simulated)' : ''}`, data: { followUpId: item.id, retryCount: item.retryCount, error: call.error } } };
  });
  publish('followup:started', { emergencyId: id, followUpId: item.id, type, responderId: item.responderId }, { emergencyId: id, watchId: e.watchId });
  await scheduler.schedule({ emergencyId: id, responderId: item.responderId, type: 'FOLLOWUP_TIMEOUT', dueAt: Date.now() + retryMs(), retryCount: item.retryCount, meta: { parentId: item.id, parentType: item.type } });
  await broadcast(id);
  if (!call.ok) await followupNoResponse(id, item.id);
}

/** A follow-up went unanswered: count it, schedule the next, or hand off / mark UNCONFIRMED when exhausted. */
export async function followupNoResponse(id, parentId) {
  const parent = await scheduler.getItem(id, parentId);
  if (!parent || parent.answered || parent.noResponseHandled) return false;
  await scheduler.markItem(id, parentId, { noResponseHandled: true });
  await scheduler.cancel(id, (it) => it.type === 'FOLLOWUP_TIMEOUT' && it.meta?.parentId === parentId);
  const e = await findEmergency(id);
  if (!e || isTerminal(e.state)) return false;
  const retry = (parent.retryCount ?? 0) + 1;
  await mutate(id, (em) => {
    em.retryCount += 1;
    em.followUp.retryCount = retry;
    return { event: { type: 'FOLLOWUP_MISSED', message: `Follow-up unanswered (${retry}/${config.followUp.maxRetries})`, data: { followUpId: parentId, retry } } };
  });
  publish('followup:missed', { emergencyId: id, followUpId: parentId, retry }, { emergencyId: id, watchId: e.watchId });
  if (retry < config.followUp.maxRetries) {
    const nextItem = await scheduler.schedule({ emergencyId: id, responderId: parent.responderId, type: parent.type === 'FOLLOWUP_CONFIRM' ? 'FOLLOWUP_CONFIRM' : 'FOLLOWUP_STATUS', delaySeconds: followSeconds(e), retryCount: retry });
    await showCountdown(id, 'FOLLOWUP', 'Next follow-up call (previous unanswered)', nextItem.dueAt);
    await broadcast(id);
    return true;
  }
  const rec = await getEmergencyResponder(id, parent.responderId);
  if (rec) {
    rec.status = 'UNRESPONSIVE';
    await saveEmergencyResponder(id, rec);
  }
  await mutate(id, (em) => ({ event: { type: 'RESPONDER_UNRESPONSIVE', message: `${rec?.name ?? 'Responder'} stopped responding to follow-ups`, data: { responderId: parent.responderId } } }));
  if (e.state === 'PERSON_REACHED') await markUnconfirmed(id, 'reported person reached but follow-up confirmation was never received', { force: true });
  else {
    await mutate(id, (em) => {
      if (canTransition(em.state, 'RESPONDER_NEEDS_BACKUP')) em.state = 'RESPONDER_NEEDS_BACKUP';
      clearResponsibility(em, 'RESPONDER_ACCEPTED');
      clearResponsibility(em, 'RESPONDER_MOVING');
      setResponsible(em, COORDINATOR.person, COORDINATOR.role, 'Hand off to another responder');
      return {};
    });
    await broadcast(id, 'response:backup', { responderId: parent.responderId, reason: 'follow-up exhausted' });
    await contactNextResponder(id, { reason: 'followup-exhausted', role: 'BACKUP_RESPONDER' });
  }
  return true;
}

// ------------------------------------------------------------------ Twilio callbacks
/** DTMF answer to the initial call. 1 = can help, 2 = cannot. */
export async function onGather(cid, digits) {
  const rec = await tw.getCallRecord(cid);
  if (!rec || rec.purpose !== 'INITIAL') return { kind: 'UNKNOWN' };
  if (!['1', '2'].includes(digits)) return { kind: 'INVALID' };
  if (!(await claimOnce(K.idem('resp', cid), 7 * 24 * 3600))) return { kind: 'DUPLICATE' };
  await tw.updateCallRecord(cid, { responded: true, digits });
  try {
    const res = digits === '1' ? await responderAccepts(rec.emergencyId, rec.responderId, { via: 'CALL' }) : await responderDeclines(rec.emergencyId, rec.responderId, { via: 'CALL' });
    return { kind: digits === '1' ? 'ACCEPTED' : 'DECLINED', res };
  } catch (err) {
    if (err instanceof InvalidTransitionError) return { kind: 'CLOSED' };
    throw err;
  }
}

/** DTMF answer to a follow-up call. STATUS: 1 reached / 2 backup / 3 travelling. CONFIRM: 1 help received / 2 backup / 3 close. */
export async function onFollowupAnswer(cid, digits) {
  const rec = await tw.getCallRecord(cid);
  if (!rec || rec.purpose !== 'FOLLOWUP') return { kind: 'UNKNOWN' };
  if (!['1', '2', '3'].includes(digits)) return { kind: 'INVALID' };
  if (!(await claimOnce(K.idem('resp', cid), 7 * 24 * 3600))) return { kind: 'DUPLICATE' };
  await tw.updateCallRecord(cid, { responded: true, digits });
  await scheduler.markItem(rec.emergencyId, rec.itemId, { answered: true });
  await scheduler.cancel(rec.emergencyId, (it) => it.type === 'FOLLOWUP_TIMEOUT' && it.meta?.parentId === rec.itemId);
  const { emergencyId: id, responderId } = rec;
  try {
    if (rec.followUpType === 'CONFIRM') {
      if (digits === '1') await helpConfirmed(id, contactOf(responderId)?.name ?? responderId);
      else if (digits === '2') await responderNeedsBackup(id, responderId, { reason: 'Responder requested backup on follow-up', via: 'CALL' });
      else await resolveEmergency(id, { confirmedBy: contactOf(responderId)?.name ?? responderId, note: 'Confirmed via follow-up call' });
    } else if (digits === '1') await responderReached(id, responderId, { via: 'CALL' });
    else if (digits === '2') await responderNeedsBackup(id, responderId, { reason: 'Responder requested backup on follow-up', via: 'CALL' });
    else await responderMoving(id, responderId, { via: 'CALL' });
  } catch (err) {
    if (err instanceof InvalidTransitionError || err instanceof ApiError) return { kind: 'CLOSED' };
    throw err;
  }
  return { kind: 'OK', digits, followUpType: rec.followUpType };
}

const TERMINAL_CALL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
/** Twilio status callback (idempotent). A finished call with no key-press counts as "no response". */
export async function onCallStatus({ cid, callSid, status }) {
  if (!(await claimOnce(K.idem('status', `${callSid}:${status}`), 24 * 3600))) return { duplicate: true };
  const rec = await tw.getCallRecord(cid);
  if (!rec) return { unknown: true };
  await tw.updateCallRecord(cid, { status, answered: rec.answered || status === 'in-progress' || status === 'answered' });
  publish('twilio:call', { emergencyId: rec.emergencyId, responderId: rec.responderId, kind: rec.purpose, status }, { emergencyId: rec.emergencyId });
  await addEvent(rec.emergencyId, 'CALL_STATUS', `Call ${status}`, { responderId: rec.responderId, purpose: rec.purpose });
  if (TERMINAL_CALL.has(status)) {
    const fresh = await tw.getCallRecord(cid);
    if (!fresh.responded) {
      if (rec.purpose === 'INITIAL') await handleAttemptFailure(rec.emergencyId, rec.responderId, rec.attemptId, status);
      else await followupNoResponse(rec.emergencyId, rec.itemId);
    }
  }
  return { ok: true };
}

/** Inbound SMS fallback (works when voice fails). Keywords: YES, NO, MOVING, REACHED, BACKUP. */
export async function onInboundSms(from, body) {
  const contact = config.contacts.find((c) => c.phone === from);
  if (!contact) return { reply: 'This number is not registered with CHER.' };
  const word = String(body ?? '').trim().toUpperCase().split(/\s+/)[0];
  const active = (await listEmergencies({ activeOnly: true })).find(() => true);
  const mine = [];
  for (const e of await listEmergencies({ activeOnly: true })) if (await getEmergencyResponder(e.id, contact.id)) mine.push(e);
  const target = mine[0] ?? active;
  if (!target) return { reply: 'CHER: there is no active emergency right now.' };
  const id = target.id;
  try {
    if (['YES', 'Y', 'HELP'].includes(word)) await responderAccepts(id, contact.id, { via: 'SMS' });
    else if (['NO', 'N'].includes(word)) await responderDeclines(id, contact.id, { via: 'SMS' });
    else if (word === 'MOVING') await responderMoving(id, contact.id, { via: 'SMS' });
    else if (word === 'REACHED') await responderReached(id, contact.id, { via: 'SMS' });
    else if (word === 'BACKUP') await responderNeedsBackup(id, contact.id, { via: 'SMS' });
    else return { reply: 'CHER: reply YES, NO, MOVING, REACHED or BACKUP.' };
  } catch (err) {
    return { reply: `CHER: could not apply that (${err.code ?? 'error'}).` };
  }
  return { reply: `CHER: ${word} recorded. Thank you.` };
}

// ------------------------------------------------------------------ AI tool actions (validated, idempotent)
export function makeActions(id, mode) {
  return {
    async getResponderAvailability() {
      const recs = await getEmergencyResponders(id);
      const list = await listResponders();
      return list.map((r) => ({ responderId: r.id, name: r.name, availability: r.status, inThisEmergency: recs.find((x) => x.responderId === r.id)?.status ?? null }));
    },
    async assignResponder({ responderId, role, reason }) {
      if (isHelperId(responderId)) throw new Error('nearby helpers are alerted by CHER itself');
      requireContact(responderId);
      if (!RESPONDER_ROLES.includes(role)) throw new Error('invalid role');
      if (await getEmergencyResponder(id, responderId)) throw new Error('responder already involved in this emergency');
      if (await globallyUnavailable(responderId)) throw new Error('responder unavailable');
      const c = contactOf(responderId);
      await saveEmergencyResponder(id, { responderId, name: c.name, role, status: 'CONTACTING', attempts: 0, pendingAttempt: null, createdAt: Date.now() });
      await addEvent(id, 'RESPONDER_ASSIGNED', `${c.name} assigned as ${ROLE_LABEL[role]} by coordinator: ${tw.safeText(reason, '', 160)}`, { responderId, role, by: 'AI' });
      await attemptContact(id, responderId);
      return { ok: true };
    },
    async requestBackup({ reason }) {
      const recs = await getEmergencyResponders(id);
      if (recs.some((r) => r.status === 'CONTACTING')) throw new Error('a responder is already being contacted');
      await addEvent(id, 'BACKUP_SUGGESTED', `Coordinator suggested backup: ${tw.safeText(reason, '', 160)}`, { by: 'AI' });
      const picked = await contactNextResponder(id, { reason: 'ai-backup', role: 'BACKUP_RESPONDER' });
      return { ok: Boolean(picked), contacted: picked?.name ?? null };
    },
    async updateEmergencyStatus({ priority, summary, nextAction }) {
      await mutate(id, (e) => {
        if (priority && PRIORITIES.includes(priority)) e.priority = priority;
        if (summary) e.summary = tw.safeText(summary, e.summary, 400);
        if (nextAction && e.responsiblePerson === COORDINATOR.person) e.nextAction = tw.safeText(nextAction, e.nextAction, 200);
        return { event: { type: 'AI_STATUS_UPDATE', message: 'Coordinator updated priority/summary', data: { by: 'AI' } } };
      });
      await broadcast(id);
      return { ok: true };
    },
    async sendEmergencySMS({ responderId, message }) {
      const c = requireContact(responderId);
      const text = tw.safeText(message, '', 300);
      if (!text) throw new Error('message rejected');
      const hash = crypto.createHash('sha1').update(`${responderId}:${text}`).digest('hex').slice(0, 16);
      if (!(await claimOnce(K.idem('ai-sms', `${id}:${hash}`), 3600))) return { ok: true, duplicate: true };
      const e = await getEmergency(id);
      const res = await tw.sendSms({ to: c.phone, body: `CHER #${tw.shortId(id)}: ${text}`, emergencyId: id, responderId, watchId: e.watchId, purpose: 'AI' });
      await addEvent(id, res.ok ? 'SMS_SENT' : 'SMS_FAILED', `Coordinator SMS to ${c.name}`, { by: 'AI' });
      return { ok: res.ok };
    },
    async startTwilioCall({ responderId }) {
      requireContact(responderId);
      const started = await attemptContact(id, responderId);
      return { ok: started, note: started ? 'call attempt started' : 'not applicable: responder must be in CONTACTING state without an attempt in flight' };
    },
    async scheduleFollowUp({ seconds }) {
      const recs = await getEmergencyResponders(id);
      const active = recs.find((r) => ACTIVE_RESP.includes(r.status));
      if (!active) throw new Error('no accepted responder to follow up with');
      const s = Math.min(config.followUp.maxSeconds, Math.max(config.followUp.minSeconds, Math.round(seconds)));
      await scheduleStatusFollowUp(id, active.responderId, s);
      return { ok: true, seconds: s };
    },
    async markResponseProgress({ note }) {
      await addEvent(id, 'AI_NOTE', tw.safeText(note, 'Coordinator note', 200), { by: 'AI' });
      return { ok: true };
    },
    async resolveEmergency({ confirmedBy, note }) {
      const e = await getEmergency(id);
      if (!e.responsibilities.HELP_CONFIRMED?.done) throw new Error('refused: no explicit human confirmation of help');
      await resolveEmergency(id, { confirmedBy: e.helpConfirmedBy ?? confirmedBy, note });
      return { ok: true };
    },
  };
}

// ------------------------------------------------------------------ wiring
export function initResponseChain() {
  initNearby();
  initCallWatcher();
  scheduler.registerHandler('OUTREACH_TIMEOUT', (it) => handleAttemptFailure(it.emergencyId, it.responderId, it.meta.attemptId, 'TIMEOUT'));
  scheduler.registerHandler('OUTREACH_RETRY', (it) => attemptContact(it.emergencyId, it.responderId));
  scheduler.registerHandler('FOLLOWUP_STATUS', runFollowUp);
  scheduler.registerHandler('FOLLOWUP_CONFIRM', runFollowUp);
  scheduler.registerHandler('FOLLOWUP_TIMEOUT', (it) => followupNoResponse(it.emergencyId, it.meta.parentId));
  bus.on('location:accepted', ({ watchId, location }) => {
    bg('location-sync', (async () => {
      const e = await activeEmergencyForWatch(watchId);
      if (!e) return;
      await mutate(e.id, (em) => {
        em.location = location;
      });
    })());
  });
}

/** After a restart: rebuild responder registry and resume persisted follow-ups. */
export async function resumeAfterRestart() {
  await initResponders();
  const active = await listEmergencies({ activeOnly: true, limit: 200 });
  const requeued = await scheduler.recover(active.map((e) => e.id));
  logger.info('chain.resumed', { activeEmergencies: active.length, requeued });
  return { active: active.length, requeued };
}
