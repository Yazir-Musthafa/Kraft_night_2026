// AI guidance for the watch: one or two short sentences, shown as small text and optionally spoken.
//
// Used in three places (CHER's theme is cooperation, so the AI helps people help each other):
//   HEART      the wearer's heart rate is above their usual while resting -> a calm, simple thing to do
//   EMERGENCY  the wearer pressed SOS -> what is happening and what to do while help comes
//   HELPER     a nearby person is on their way to help -> how to approach and what to check when they arrive
//
// Safety rules, enforced in code and not only in the prompt:
//  - never a diagnosis, a named condition, or medication advice (validated output; anything else is replaced)
//  - only the facts sent by the watch are used; no phone numbers, no coordinates
//  - never blocks: a timeout, a missing key or bad output falls back to fixed, reviewed sentences
//  - rate limited per watch, and identical situations are answered from a short cache
import { Agent, run, setDefaultOpenAIKey, setTracingDisabled } from '@openai/agents';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logging.js';
import { containsDiagnosis } from './validation.js';

export const ADVICE_KINDS = ['HEART', 'EMERGENCY', 'HELPER'];

export const adviceRequestSchema = z.object({
  kind: z.enum(ADVICE_KINDS),
  // HEART
  heart: z
    .object({
      bpm: z.number().min(20).max(250),
      baseline: z.number().min(20).max(250).nullish(),
      level: z.enum(['ELEVATED', 'HIGH']),
      resting: z.boolean().optional(),
    })
    .optional(),
  // EMERGENCY (about the person's own emergency)
  emergency: z
    .object({
      state: z.string().max(40),
      responder: z.enum(['NEARBY_HELPER', 'CONTACT']).nullish(),
      etaMinutes: z.number().min(0).max(600).nullish(),
      fallbackCall: z.boolean().optional(), // the watch is about to call 112
    })
    .optional(),
  // HELPER (about the person being helped)
  helper: z
    .object({
      distanceM: z.number().min(0).max(100000).nullish(),
      arrived: z.boolean().optional(),
      situation: z.string().max(120).nullish(),
    })
    .optional(),
});

const OUTPUT = z.object({ text: z.string() });
const MAX_CHARS = 150;
const BANNED = /\b(aspirin|ibuprofen|paracetamol|tablet|pill|dose|dosage|medication|medicine|mg|prescription|diagnos\w*)\b/i;

const INSTRUCTIONS = [
  "You are CHER's on-watch guide. Write ONE suggestion for a tiny smartwatch screen.",
  'Format: at most 2 short sentences, at most 22 words in total, plain words, calm, addressed to "you".',
  'Never diagnose, never name a medical condition, never mention medicine or doses, never claim certainty (use "higher than usual", "may").',
  'Use only the facts in the JSON. Do not invent times, places, names or numbers.',
  'HEART: suggest one simple safe action (sit down, rest, slow breaths, sip water) and say to press SOS if they feel unwell.',
  'EMERGENCY: reassure, say who is coming if the facts say so, tell them to stay where they are if it is safe and keep the watch on. If fallbackCall is true say the watch will call 112 unless they cancel.',
  'HELPER: this is for a person going to help a stranger. Tell them to approach safely, speak to the person, check whether they respond, and to call 112 and stay with them if there is no response. If arrived is false, focus on getting there safely.',
  'Return JSON {"text": "..."} only.',
].join(' ');

// ------------------------------------------------------------------ deterministic fallback (reviewed sentences)
export function fallbackAdvice(req) {
  switch (req.kind) {
    case 'HEART':
      return req.heart?.level === 'HIGH'
        ? 'Heart rate is high at rest. Sit and breathe slowly. CHER will check on you.'
        : 'Heart rate is higher than usual. Sit, rest, breathe slowly.';
    case 'EMERGENCY': {
      const e = req.emergency ?? {};
      if (e.fallbackCall) return 'No one answered yet. The watch will call 112 unless you cancel.';
      if (e.responder === 'NEARBY_HELPER') return `A nearby person is coming${e.etaMinutes ? ` (about ${Math.max(1, Math.round(e.etaMinutes))} min)` : ''}. Stay put if safe.`;
      if (e.responder === 'CONTACT') return 'Your contact is on the way. Stay put if safe.';
      if (e.state === 'UNCONFIRMED') return 'No one has confirmed yet. CHER keeps trying. Stay put if safe.';
      return 'Help is being arranged. Stay put if safe.';
    }
    default: {
      const h = req.helper ?? {};
      return h.arrived
        ? 'Speak to them. No reply? Call 112 and stay with them.'
        : 'Move safely. Call out when you arrive.';
    }
  }
}

// ------------------------------------------------------------------ model call
let runner = run; // replaceable in tests
export function setAdviceRunnerForTests(fn) {
  runner = fn ?? run;
  cache.clear();
  lastCall.clear();
  aiDownUntil = 0;
}
export const adviceAiEnabled = () => runner !== run || Boolean(config.openai.apiKey);

// Circuit breaker: when the AI fails (no credits, no network, slow) stop asking for a minute instead of making every request wait.
let aiDownUntil = 0;
const BREAKER_MS = 60_000;
const ADVICE_TIMEOUT_MS = () => Math.min(4_000, config.openai.timeoutMs);

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (config.openai.apiKey) setDefaultOpenAIKey(config.openai.apiKey);
  setTracingDisabled(true); // health facts are not sent to trace storage
  configured = true;
}

/** What the model may see: numbers and states only. */
const factsOf = (req) => ({ kind: req.kind, heart: req.heart, emergency: req.emergency, helper: req.helper });

function cleanText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_CHARS) throw new Error('AI_TEXT_LENGTH');
  if (containsDiagnosis(t) || BANNED.test(t)) throw new Error('AI_TEXT_REJECTED');
  return t;
}

// ------------------------------------------------------------------ public API
const cache = new Map(); // key -> { at, res }
const lastCall = new Map(); // watchId -> timestamps (rate limit)
const CACHE_MS = 20_000;
const MIN_GAP_MS = 3_000;
const PER_HOUR = 90;

const cacheKey = (req) => JSON.stringify([req.kind, req.heart?.level, req.emergency?.state, req.emergency?.responder, req.emergency?.fallbackCall, req.helper?.arrived, req.helper?.situation]);

/** Returns {text, source: 'AI'|'RULES', cached?}. Never throws for model problems. */
export async function advise(watchId, req) {
  const now = Date.now();
  const calls = (lastCall.get(watchId) ?? []).filter((t) => now - t < 3_600_000);
  if (calls.length && now - calls[calls.length - 1] < MIN_GAP_MS) return { ...fallbackResult(req), limited: true };
  if (calls.length >= PER_HOUR) return { ...fallbackResult(req), limited: true };
  calls.push(now);
  lastCall.set(watchId, calls);

  const key = `${watchId}|${cacheKey(req)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return { ...hit.res, cached: true };

  let res;
  if (!adviceAiEnabled()) res = fallbackResult(req, 'AI_DISABLED');
  else if (now < aiDownUntil) res = fallbackResult(req, 'AI_PAUSED');
  else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ADVICE_TIMEOUT_MS());
    try {
      ensureConfigured();
      const agent = new Agent({ name: 'CHER Wear Guide', instructions: INSTRUCTIONS, model: config.openai.model, outputType: OUTPUT });
      const result = await Promise.race([
        runner(agent, `Facts (JSON):\n${JSON.stringify(factsOf(req))}`, { maxTurns: 1, signal: ac.signal }),
        new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('AI_TIMEOUT')))),
      ]);
      const parsed = OUTPUT.safeParse(result?.finalOutput);
      if (!parsed.success) throw new Error('AI_INVALID_OUTPUT');
      res = { text: cleanText(parsed.data.text), source: 'AI' };
    } catch (err) {
      logger.warn('advice.fallback', { kind: req.kind, reason: err?.message });
      aiDownUntil = Date.now() + BREAKER_MS;
      res = fallbackResult(req, err?.message);
    } finally {
      clearTimeout(timer);
    }
  }
  cache.set(key, { at: now, res });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return res;
}

function fallbackResult(req, reason) {
  return { text: fallbackAdvice(req), source: 'RULES', ...(reason ? { reason } : {}) };
}

/** A plain-language description of why somebody needs help, for the helper's watch. Never a diagnosis. */
export function situationOf(e) {
  const s = new Set(e.signals ?? []);
  if (e.triggerType === 'MANUAL_SOS') return 'The person pressed SOS';
  if (e.triggerType === 'USER_NEEDS_HELP') return 'The person asked for help';
  if (s.has('FALL_LIKE_MOTION') || e.triggerType === 'AUTO_FALL_NO_RESPONSE') return 'A possible fall was detected and there was no reply';
  if (s.has('HEART_RATE_ABNORMAL')) return 'Unusual heart-rate readings and no reply';
  if (s.has('INACTIVITY')) return 'The person has been very still for a long time';
  return 'The watch detected an emergency signal';
}
