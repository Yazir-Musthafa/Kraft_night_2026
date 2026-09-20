// Structured JSON logging with secret/phone redaction.
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(token|secret|password|authorization|api[-_]?key|auth|sid|redis_?url)/i;
const PHONE = /\+\d{7,15}/g;

export function maskPhone(p) {
  if (!p || typeof p !== 'string') return p;
  return p.length <= 5 ? '***' : `${p.slice(0, 2)}${'*'.repeat(Math.max(3, p.length - 5))}${p.slice(-3)}`;
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(PHONE, (m) => maskPhone(m));
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

let sink = (line) => process.stdout.write(`${line}\n`);
export function setLogSink(fn) {
  sink = fn;
}

export function log(level, event, fields = {}) {
  if ((LEVELS[level] ?? 20) < (LEVELS[config.logLevel] ?? 20)) return;
  const entry = { ts: new Date().toISOString(), level, event, ...redact(fields) };
  sink(JSON.stringify(entry));
}

export const logger = {
  debug: (e, f) => log('debug', e, f),
  info: (e, f) => log('info', e, f),
  warn: (e, f) => log('warn', e, f),
  error: (e, f) => log('error', e, f),
};

/** Every emergency log line carries emergencyId, event, timestamp, state, responsiblePerson, responsibleRole. */
export function emergencyLog(level, emergency, event, extra = {}) {
  log(level, event, {
    emergencyId: emergency?.id,
    state: emergency?.state,
    responsiblePerson: emergency?.responsiblePerson,
    responsibleRole: emergency?.responsibleRole,
    ...extra,
  });
}
