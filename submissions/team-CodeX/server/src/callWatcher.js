// Demo helper: "the call was answered" == "the contact pressed 1", for every call stage, without a keypress.
//
// On a Twilio TRIAL account the call is started from a hosted URL and carries no statusCallback, so CHER normally only
// learns something when the person on the phone presses a key. For live demos nobody should have to: we poll Twilio's
// call status instead and drive the same handlers a keypress would:
//
//   call 1  INITIAL            queued -> ringing -> answered   =>  accepted (then "on the way" after a short scripted step)
//   call 2  FOLLOWUP / STATUS  answered                        =>  person reached
//   call 3  FOLLOWUP / CONFIRM answered                        =>  help confirmed  (the person closes it with I'M SAFE)
//
// Each stage also updates the contact status shown on the watch: "Call placed", "Phone is ringing", "Call answered".
//
// Only active when ALL hold: CHER_DEMO_MODE=true, CHER_DEMO_AUTO_ANSWER=true (explicit opt-in, default off), real
// (non-simulated) Twilio. Honesty rules: "answered" is a real Twilio event; the effect of answering is recorded in the
// timeline as simulated ("no keypress confirmed"); "on the way" is a SCRIPTED demo step and says so. Nobody is ever
// auto-resolved: closing stays with the person's I'M SAFE. Nearby watch helpers are never touched here.
import { config } from './config.js';
import { bus } from './events.js';
import { logger } from './logging.js';
import { addEvent, broadcast, getEmergency, getEmergencyResponder, isTerminal, markResponsibility, mutate } from './emergency.js';
import { cidFromCallSid, getCallRecord, callsApi, isSimulated } from './twilio.js';
import { onFollowupAnswer, onGather, responderMoving } from './responseChain.js';

const pollMs = () => Math.max(50, Number.parseInt(process.env.CHER_DEMO_POLL_MS ?? '', 10) || 1_000);
const MAX_POLL_MS = 90_000; // ring ~30 s + a trial-account notice + the call itself + margin
const seconds = (env, d) => Math.max(1, Number.parseInt(process.env[env] ?? '', 10) || d);
export const timings = () => ({ movingAfter: seconds('CHER_DEMO_AUTO_MOVING_SECONDS', 3) });

let fetchStatus = async (sid) => {
  const c = await callsApi()(sid).fetch();
  return { status: c.status, duration: Number(c.duration ?? 0) };
};
/** Tests inject a fake Twilio status source. */
export function setStatusFetcherForTests(fn) {
  fetchStatus = fn;
}

const watching = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.()); // never keeps the process alive
const live = async (id) => {
  const e = await getEmergency(id).catch(() => null);
  return Boolean(e) && !isTerminal(e.state);
};
export const autoAnswerEnabled = () => config.demoMode && ['1', 'true', 'yes', 'on'].includes(String(process.env.CHER_DEMO_AUTO_ANSWER ?? '').toLowerCase());
const answered = ({ status, duration }) => status === 'in-progress' || (status === 'completed' && duration > 0);
const dead = ({ status }) => ['busy', 'no-answer', 'failed', 'canceled'].includes(status);

/** Shown on the watch and in the timeline while a call moves through its stages. */
async function stage(emergencyId, text, { contact = false } = {}) {
  await mutate(emergencyId, (e) => {
    e.contactStatus = text;
    if (contact) markResponsibility(e, 'CONTACT_ATTEMPTED', 'TWILIO_RINGING'); // the phone really rang: the alert was delivered
    return { event: { type: 'CALL_STAGE', message: text } };
  });
  await broadcast(emergencyId);
}

async function onAnswered({ sid, emergencyId, responderId, kind, followUpType, name }, s) {
  const cid = await cidFromCallSid(sid); // the call record (created before the call) is keyed by our own id
  const rec = cid ? await getCallRecord(cid) : null;
  if (!cid || !rec) return logger.warn('callwatch.no_record', { emergencyId });
  // Trial calls can show 'in-progress' briefly and end before a script is confirmed, so say exactly what was seen.
  await addEvent(emergencyId, 'CALL_ANSWERED', `${kind === 'INITIAL' ? 'First call' : `Follow-up call (${followUpType ?? 'STATUS'})`} to ${name} was answered (Twilio in-progress). No keypress was confirmed: applying the answer automatically for the demo (simulated demo step)`, { responderId, status: s.status, duration: s.duration });
  if (kind === 'INITIAL') {
    await onGather(cid, '1'); // same path as pressing 1: accepted
    await sleep(timings().movingAfter * 1000);
    if (await live(emergencyId)) {
      await addEvent(emergencyId, 'DEMO_STEP', 'Responder on the way (simulated demo step)', { responderId });
      await responderMoving(emergencyId, responderId, { via: 'DEMO_AUTO' });
    }
  } else {
    await onFollowupAnswer(cid, '1'); // STATUS: 1 = reached the person. CONFIRM: 1 = help received.
  }
}

async function watch(call) {
  const { sid, emergencyId, responderId, kind } = call;
  const key = `${emergencyId}:${responderId}:${sid}`;
  if (watching.has(key)) return;
  watching.add(key);
  const label = kind === 'INITIAL' ? 'Call' : 'Follow-up call';
  try {
    call.name = (await getEmergencyResponder(emergencyId, responderId))?.name ?? 'the contact';
    if (kind === 'FOLLOWUP') {
      const cid = await cidFromCallSid(sid);
      call.followUpType = (cid ? await getCallRecord(cid) : null)?.followUpType;
    }
    await stage(emergencyId, `${label} placed to ${call.name}`);
    let ringing = false;
    const t0 = Date.now();
    while (Date.now() - t0 < MAX_POLL_MS) {
      await sleep(pollMs());
      if (!(await live(emergencyId))) return;
      let s;
      try {
        s = await fetchStatus(sid);
      } catch (err) {
        logger.debug('callwatch.fetch_failed', { message: err?.message });
        continue;
      }
      if (dead(s)) {
        await stage(emergencyId, `${label} to ${call.name} ${s.status === 'no-answer' ? 'was not answered' : `ended (${s.status})`}`);
        return;
      }
      if (s.status === 'ringing' && !ringing) {
        ringing = true;
        await stage(emergencyId, `Phone is ringing (${call.name})`, { contact: kind === 'INITIAL' });
      }
      if (!answered(s)) continue;
      await stage(emergencyId, `${label} answered by ${call.name}`);
      logger.info('callwatch.answered', { emergencyId, kind, status: s.status });
      await onAnswered(call, s);
      return;
    }
  } catch (err) {
    logger.warn('callwatch.failed', { emergencyId, message: err?.message, code: err?.code });
  } finally {
    watching.delete(key);
  }
}

let wired = false;
export function initCallWatcher() {
  if (wired) return;
  wired = true;
  if (autoAnswerEnabled()) logger.warn('callwatch.enabled', { note: 'CHER_DEMO_AUTO_ANSWER=true: an answered call is treated as key press 1 (all call stages, simulated demo steps)' });
  bus.on('publish', (m) => {
    const p = m.payload;
    if (m.event !== 'twilio:call' || p?.status !== 'queued' || !p.sid || !['INITIAL', 'FOLLOWUP'].includes(p.kind)) return;
    if (!autoAnswerEnabled() || isSimulated()) return;
    if (String(p.responderId ?? '').startsWith('H:')) return;
    watch({ sid: p.sid, emergencyId: p.emergencyId, responderId: p.responderId, kind: p.kind }).catch(() => {});
  });
}
