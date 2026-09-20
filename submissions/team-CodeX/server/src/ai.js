// CHER Response Coordinator: OpenAI Agents SDK + Zod structured output + deterministic fallback.
// The AI never executes anything itself. It can only (a) return validated structured output and
// (b) call the narrow, validated tools defined below. It is never a single point of failure.
import { Agent, run, tool, setDefaultOpenAIKey, setTracingDisabled } from '@openai/agents';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logging.js';
import { getEmergency, getEmergencyResponders, getTimeline } from './emergency.js';
import { getHealthSummary } from './health.js';
import { getLatestLocation } from './location.js';
import { aiOutputSchema, aiOutputAgentSchema, containsDiagnosis, RESPONDER_ROLES, PRIORITIES } from './validation.js';
import { deterministicPriority } from './sensors.js';
import { safeText } from './twilio.js';

let runner = run; // replaceable in tests
let modelOverride = null; // tests: a fake Agents SDK Model, so the real agent/tool/schema plumbing still runs
let configured = false;

export function setModelForTests(model) {
  modelOverride = model;
  resetAiBreaker();
}

// ---------------------------------------------------------------- fail-fast circuit breaker
// A dead AI (no credits, bad key, outage) must not delay the response: the SDK retries 429s with backoff, so without this
// EVERY emergency would wait out the full AI timeout before anyone is contacted. Model misbehaviour (invalid output,
// diagnosis text) is not an outage and does not trip it.
const breaker = { openUntil: 0, reason: null };
export function resetAiBreaker() {
  breaker.openUntil = 0;
  breaker.reason = null;
}
const isQuotaOrAuth = (err) =>
  err?.status === 401 || /insufficient_quota|no credits|exceeded your current quota|billing|incorrect api key|invalid api key/i.test(String(err?.message ?? err));
function tripBreaker(err) {
  if (/AI_INVALID_OUTPUT|AI_DIAGNOSIS_TEXT_REJECTED/.test(String(err?.message))) return; // the model answered: not an outage
  const quota = isQuotaOrAuth(err);
  const seconds = quota ? config.openai.quotaBreakerSeconds : config.openai.breakerSeconds;
  const wasOpenFor = breaker.openUntil - Date.now();
  // A real cause (e.g. no credits) may arrive after the timeout; it may lengthen the pause but never shorten it.
  breaker.openUntil = Math.max(breaker.openUntil, Date.now() + seconds * 1000);
  breaker.reason = quota ? 'AI_UNAVAILABLE_NO_CREDITS_OR_BAD_KEY' : 'AI_PAUSED_AFTER_FAILURE';
  if (wasOpenFor <= 0 || quota) logger.warn('ai.breaker_open', { seconds, reason: breaker.reason, cause: String(err?.message ?? err).slice(0, 120) });
}

export function setRunnerForTests(fn) {
  runner = fn ?? run;
  resetAiBreaker();
}
export const aiEnabled = () => runner !== run || modelOverride !== null || Boolean(config.openai.apiKey);

function ensureConfigured() {
  if (configured) return;
  if (config.openai.apiKey) setDefaultOpenAIKey(config.openai.apiKey);
  setTracingDisabled(true); // health/location facts are not sent to trace storage
  configured = true;
}

const CALL_PROMPT = 'Are you near the person and can you reach the location? Press 1 if you can help. Press 2 if you cannot help.';
const STANDARD_INSTRUCTION = 'Reach the reported location';

// ---------------------------------------------------------------- deterministic fallback
const TRIGGER_SUMMARY = {
  MANUAL_SOS: 'The person pressed the manual SOS button.',
  USER_NEEDS_HELP: 'The person asked for help when the watch checked on them.',
  AUTO_FALL_NO_RESPONSE: 'A possible fall was detected and the person did not respond to the watch check-in.',
  AUTO_MULTI_SIGNAL: 'Multiple emergency signals were detected together.',
  AUTO_HEART_RATE_ANOMALY: 'An unusual heart-rate pattern was detected.',
  AUTO_INACTIVITY: 'Prolonged inactivity was detected.',
};

const SIGNAL_TEXT = {
  HEART_RATE_ABNORMAL: 'unusual heart-rate pattern',
  IMPACT: 'impact-like motion',
  FALL_LIKE_MOTION: 'possible fall',
  INACTIVITY: 'prolonged inactivity',
  UNUSUAL_MOTION: 'unusual motion pattern',
  NO_USER_RESPONSE: 'no response to check-in',
  USER_REQUESTED_HELP: 'the person asked for help',
};

/** Rule-based analysis. Deterministic, needs no network, and never states a diagnosis. */
export function deterministicAnalysis(e) {
  const priority = deterministicPriority(e.triggerType, e.signals, e.userResponse);
  const signalList = (e.signals ?? []).map((s) => SIGNAL_TEXT[s] ?? s.toLowerCase()).join(', ');
  const summary = TRIGGER_SUMMARY[e.triggerType] ?? 'An emergency signal was received.';
  const roles = [{ role: 'FIRST_RESPONDER', reason: 'Someone needs to physically reach and check on the person.' }];
  if (priority === 'HIGH' || priority === 'CRITICAL') roles.push({ role: 'EMERGENCY_SERVICES_CALLER', reason: 'A human should decide whether to involve local emergency services.' });
  if (priority === 'CRITICAL') roles.push({ role: 'BACKUP_RESPONDER', reason: 'Multiple corroborating signals: line up backup early.' });
  const followUpSeconds = priority === 'CRITICAL' ? 60 : priority === 'HIGH' ? 90 : config.followUp.intervalSeconds;
  const loc = e.location ? 'We have their latest location.' : 'Their location is not currently available.';
  return {
    priority,
    summary,
    triggerAssessment: signalList ? `Signals: ${signalList}.` : 'Emergency raised without additional sensor signals.',
    recommendedRoles: roles,
    nextAction: STANDARD_INSTRUCTION,
    responsibleRole: 'FIRST_RESPONDER',
    needsBackup: priority === 'CRITICAL',
    followUpSeconds,
    callMessage: `This is CHER emergency coordination. A person may need assistance. ${summary} ${loc} ${CALL_PROMPT}`,
    smsMessage: `A person may need assistance. ${summary}`,
  };
}

/** Normalise validated AI output: floors priority, scrubs text, guarantees the DTMF prompt. */
export function finalizeOutput(out, e) {
  const fb = deterministicAnalysis(e);
  const floor = PRIORITIES.indexOf(fb.priority);
  const priority = PRIORITIES[Math.max(floor, PRIORITIES.indexOf(out.priority))];
  let call = safeText(out.callMessage, fb.callMessage, 600);
  if (!/press 1/i.test(call)) call = `${call} ${CALL_PROMPT}`;
  const seen = new Set();
  const roles = out.recommendedRoles.filter((r) => (seen.has(r.role) ? false : seen.add(r.role)));
  return {
    ...out,
    priority,
    summary: safeText(out.summary, fb.summary, 400),
    triggerAssessment: safeText(out.triggerAssessment, fb.triggerAssessment, 400),
    nextAction: safeText(out.nextAction, fb.nextAction, 200),
    callMessage: call,
    smsMessage: safeText(out.smsMessage, fb.smsMessage, 320),
    recommendedRoles: roles,
    followUpSeconds: Math.min(config.followUp.maxSeconds, Math.max(config.followUp.minSeconds, out.followUpSeconds)),
  };
}

// ---------------------------------------------------------------- facts (no invented data)
const round3 = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : null);

async function buildFacts(e, mode) {
  const responders = await getEmergencyResponders(e.id);
  const timeline = (await getTimeline(e.id)).slice(-10).map((t) => ({ at: new Date(t.ts).toISOString(), type: t.type, message: t.message }));
  return {
    mode,
    emergencyId: e.id,
    triggerType: e.triggerType,
    state: e.state,
    signals: e.signals,
    userResponse: e.userResponse,
    health: e.healthSummary,
    motion: e.motionSummary,
    locationKnown: Boolean(e.location),
    approxLocation: e.location ? { lat: round3(e.location.latitude), lng: round3(e.location.longitude), accuracyMeters: e.location.accuracy } : null,
    responders: responders.map((r) => ({ id: r.responderId, name: r.name, role: r.role, status: r.status, attempts: r.attempts })),
    priorityFloorFromRules: deterministicPriority(e.triggerType, e.signals, e.userResponse),
    recentTimeline: timeline,
  };
}

const INSTRUCTIONS = `You are the CHER Response Coordinator, part of a prototype emergency coordination system.
A wearable detected signals about a person. Human responders will be contacted by phone and SMS.

HARD RULES
- Use ONLY the facts you are given or fetch via tools. Never invent facts (no names, times, places, vitals).
- NEVER diagnose or name any medical condition. Do not say "heart attack", "cardiac arrest", "stroke", "seizure", or any disease.
  Use neutral wording such as: possible health abnormality, unusual heart-rate pattern, possible fall,
  unusual motion pattern, prolonged inactivity, multiple emergency signals detected.
- Never put coordinates, phone numbers or vitals in callMessage/smsMessage; the server adds location details.
- callMessage: at most 3 short sentences, spoken aloud, must say the person may need assistance and end by asking whether the
  contact can reach the person, with "Press 1 if you can help. Press 2 if you cannot help."
- smsMessage: at most 2 short sentences, plain text.
- priority: LOW|MEDIUM|HIGH|CRITICAL. Manual SOS and a request for help are at least HIGH. Never go below priorityFloorFromRules.
- recommendedRoles may only use: ${RESPONDER_ROLES.join(', ')}. responsibleRole is the role that should act next.
- nextAction is one concrete sentence for the responsible role.
- followUpSeconds: seconds until the next status check (15-900); shorter for higher priority.
- Success means a human accepted responsibility, the person was reached and explicitly confirmed safe. Never claim the emergency is resolved.

TOOLS
- Read tools are always available. In mode INITIAL the response chain already contacts the primary responder:
  do NOT call assignment/contact tools. In mode REPLAN you may use assignResponder, requestBackup, sendEmergencySMS,
  startTwilioCall, scheduleFollowUp when the facts justify it. Tools validate everything and may refuse.
Return the structured result only.`;

// ---------------------------------------------------------------- tools (controlled surface)
const empty = z.object({});
const j = (v) => JSON.stringify(v);

/** Build the agent tools for ONE emergency. The model cannot address any other emergency. */
export function buildTools(emergencyId, actions, mode) {
  const act = mode === 'REPLAN';
  const guard = async (fn) => {
    try {
      return j(await fn());
    } catch (err) {
      return j({ ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  };
  const denied = () => j({ ok: false, error: `not permitted in mode ${mode}` });

  return [
    tool({
      name: 'getEmergencyState',
      description: 'Get the current emergency state, priority, responsible person, coverage and next action.',
      parameters: empty,
      execute: () =>
        guard(async () => {
          const e = await getEmergency(emergencyId);
          return { id: e.id, state: e.state, priority: e.priority, responsiblePerson: e.responsiblePerson, responsibleRole: e.responsibleRole, nextAction: e.nextAction, coverage: e.coverage?.percent, retryCount: e.retryCount };
        }),
    }),
    tool({
      name: 'getLatestHealthSummary',
      description: 'Get the latest heart-rate summary for the watch wearer (trend, baseline, availability).',
      parameters: empty,
      execute: () => guard(async () => getHealthSummary((await getEmergency(emergencyId)).watchId)),
    }),
    tool({
      name: 'getLatestLocation',
      description: 'Get whether a recent location fix exists and its approximate position and age.',
      parameters: empty,
      execute: () =>
        guard(async () => {
          const loc = await getLatestLocation((await getEmergency(emergencyId)).watchId);
          return loc ? { known: true, lat: round3(loc.latitude), lng: round3(loc.longitude), accuracyMeters: loc.accuracy, ageSeconds: Math.round((Date.now() - loc.timestamp) / 1000) } : { known: false };
        }),
    }),
    tool({
      name: 'getResponderAvailability',
      description: 'List configured responders with their availability and status in this emergency. No phone numbers are returned.',
      parameters: empty,
      execute: () => guard(() => actions.getResponderAvailability()),
    }),
    tool({
      name: 'assignResponder',
      description: 'Assign a responder to a role. The backend validates the responder, role and availability.',
      parameters: z.object({ responderId: z.string(), role: z.enum(RESPONDER_ROLES), reason: z.string() }),
      execute: (a) => (act ? guard(() => actions.assignResponder(a)) : denied()),
    }),
    tool({
      name: 'requestBackup',
      description: 'Request backup: contacts the next available responder.',
      parameters: z.object({ reason: z.string() }),
      execute: (a) => (act ? guard(() => actions.requestBackup(a)) : denied()),
    }),
    tool({
      name: 'updateEmergencyStatus',
      description: 'Update priority, summary or next action text. Cannot change the emergency state (only real human responses can).',
      parameters: z.object({ priority: z.enum(PRIORITIES).nullable(), summary: z.string().nullable(), nextAction: z.string().nullable() }),
      execute: (a) => guard(() => actions.updateEmergencyStatus(a)),
    }),
    tool({
      name: 'sendEmergencySMS',
      description: 'Send a short SMS (max 300 chars) to a known responder. Duplicate identical messages are suppressed.',
      parameters: z.object({ responderId: z.string(), message: z.string() }),
      execute: (a) => (act ? guard(() => actions.sendEmergencySMS(a)) : denied()),
    }),
    tool({
      name: 'startTwilioCall',
      description: 'Start an emergency call to a known responder who has not yet been contacted.',
      parameters: z.object({ responderId: z.string() }),
      execute: (a) => (act ? guard(() => actions.startTwilioCall(a)) : denied()),
    }),
    tool({
      name: 'scheduleFollowUp',
      description: 'Schedule the next follow-up status call (15-900 seconds from now).',
      parameters: z.object({ seconds: z.number().int() }),
      execute: (a) => (act ? guard(() => actions.scheduleFollowUp(a)) : denied()),
    }),
    tool({
      name: 'markResponseProgress',
      description: 'Add a progress note to the emergency timeline. Does not change state or coverage.',
      parameters: z.object({ note: z.string() }),
      execute: (a) => guard(() => actions.markResponseProgress(a)),
    }),
    tool({
      name: 'resolveEmergency',
      description: 'Attempt to close the emergency. Refused unless a human has explicitly confirmed help was received.',
      parameters: z.object({ confirmedBy: z.string(), note: z.string() }),
      execute: (a) => guard(() => actions.resolveEmergency(a)),
    }),
  ];
}

// ---------------------------------------------------------------- entry point
/**
 * Analyse an emergency. Always returns a valid output: AI when available and valid, deterministic otherwise.
 * @returns {Promise<{output: object, source: 'AI'|'FALLBACK', error?: string}>}
 */
export async function analyzeEmergency(emergencyId, actions, { mode = 'INITIAL', timeoutMs = config.openai.timeoutMs } = {}) {
  const e = await getEmergency(emergencyId);
  if (!aiEnabled()) return { output: deterministicAnalysis(e), source: 'FALLBACK', error: 'AI_DISABLED' };
  if (Date.now() < breaker.openUntil) {
    const left = Math.ceil((breaker.openUntil - Date.now()) / 1000);
    return { output: deterministicAnalysis(e), source: 'FALLBACK', error: `${breaker.reason} (AI paused, retrying in ${left}s)` };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    ensureConfigured();
    const facts = await buildFacts(e, mode);
    const agent = new Agent({
      name: 'CHER Response Coordinator',
      instructions: INSTRUCTIONS,
      model: modelOverride ?? config.openai.model,
      tools: buildTools(emergencyId, actions, mode),
      outputType: aiOutputAgentSchema,
    });
    const running = Promise.resolve(runner(agent, `Emergency facts (JSON):\n${JSON.stringify(facts)}`, { maxTurns: config.openai.maxTurns, signal: ac.signal }));
    running.catch((err) => {
      if (!ac.signal.aborted || String(err?.message) !== 'AI_TIMEOUT') tripBreaker(err); // also learns the true cause when it arrives after the timeout
    });
    const result = await Promise.race([
      running,
      new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('AI_TIMEOUT')))),
    ]);
    const parsed = aiOutputSchema.safeParse(result?.finalOutput);
    if (!parsed.success) throw new Error(`AI_INVALID_OUTPUT: ${parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')).join(',')}`);
    const texts = [parsed.data.summary, parsed.data.triggerAssessment, parsed.data.nextAction, parsed.data.callMessage, parsed.data.smsMessage];
    if (texts.some(containsDiagnosis)) throw new Error('AI_DIAGNOSIS_TEXT_REJECTED');
    resetAiBreaker(); // the AI is healthy again
    return { output: finalizeOutput(parsed.data, e), source: 'AI' };
  } catch (err) {
    tripBreaker(err);
    logger.warn('ai.fallback', { emergencyId, reason: err?.message });
    return { output: deterministicAnalysis(e), source: 'FALLBACK', error: err?.message ?? 'AI_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}
