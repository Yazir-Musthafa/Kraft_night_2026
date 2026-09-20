// Zod schemas for every external input: REST bodies, Socket.IO payloads, AI output, Twilio params.
import { z } from 'zod';

export const EMERGENCY_STATES = [
  'ACTIVE',
  'RESPONDER_SEARCHING',
  'RESPONDER_ACCEPTED',
  'RESPONDER_MOVING',
  'RESPONDER_NEEDS_BACKUP',
  'PERSON_REACHED',
  'HELP_CONFIRMED',
  'RESOLVED',
  'CANCELLED',
  'UNCONFIRMED',
];
export const TERMINAL_STATES = ['RESOLVED', 'CANCELLED'];

export const TRIGGER_TYPES = [
  'MANUAL_SOS',
  'USER_NEEDS_HELP',
  'AUTO_FALL_NO_RESPONSE',
  'AUTO_MULTI_SIGNAL',
  'AUTO_HEART_RATE_ANOMALY',
  'AUTO_INACTIVITY',
];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const RESPONDER_ROLES = [
  'FIRST_RESPONDER',
  'EMERGENCY_SERVICES_CALLER',
  'AED_RUNNER',
  'BACKUP_RESPONDER',
  'ROUTE_GUIDE',
  'TRANSPORT_SUPPORT',
];
export const SIGNAL_TYPES = ['HEART_RATE_ABNORMAL', 'IMPACT', 'FALL_LIKE_MOTION', 'INACTIVITY', 'UNUSUAL_MOTION', 'NO_USER_RESPONSE', 'USER_REQUESTED_HELP'];

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/, 'invalid id');
const ts = z.number().int().positive();

export const locationSchema = z.object({
  watchId: id.optional(),
  eventId: id.optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).nullish(),
  timestamp: ts.optional(),
  provider: z.string().max(20).nullish(),
});

export const healthSampleSchema = z.object({
  watchId: id.optional(),
  eventId: id.optional(),
  bpm: z.number().min(0).max(400).nullable(),
  accuracy: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNRELIABLE', 'NO_CONTACT', 'UNKNOWN']).optional(),
  timestamp: ts.optional(),
  source: z.string().max(30).optional(),
  battery: z.number().min(0).max(100).optional(),
  monitoringState: z.enum(['NORMAL', 'POSSIBLE_ANOMALY', 'VERIFYING', 'ESCALATING', 'ACTIVE_EMERGENCY']).optional(),
  motion: z
    .object({
      peakG: z.number().min(0).max(100).optional(),
      inactivitySeconds: z.number().min(0).max(86400).optional(),
      gyroPeak: z.number().min(0).max(1000).optional(),
    })
    .optional(),
});

export const emergencyCreateSchema = z.object({
  emergencyId: id.optional(),
  eventId: id.optional(),
  watchId: id.optional(),
  triggerType: z.enum(TRIGGER_TYPES),
  triggeredAt: ts.optional(),
  signals: z.array(z.enum(SIGNAL_TYPES)).max(10).optional(),
  userResponse: z.enum(['NO_RESPONSE', 'NEEDS_HELP', 'NONE']).optional(),
  health: z
    .object({
      bpm: z.number().min(0).max(400).nullish(),
      baselineBpm: z.number().min(0).max(400).nullish(),
      trend: z.string().max(60).nullish(),
      sensorAvailable: z.boolean().optional(),
    })
    .optional(),
  motion: z
    .object({
      event: z.string().max(60).nullish(),
      peakG: z.number().min(0).max(100).nullish(),
      inactivitySeconds: z.number().min(0).max(86400).nullish(),
    })
    .optional(),
  location: locationSchema.nullish(),
  battery: z.number().min(0).max(100).optional(),
  demo: z.boolean().optional(),
  nearbyAlerts: z.boolean().optional(),
});

export const acknowledgeSchema = z.object({
  by: z.enum(['WATCH', 'RESPONDER', 'DASHBOARD']).default('WATCH'),
  responderId: id.optional(),
  eventId: id.optional(),
});

export const acceptSchema = z.object({
  responderId: id,
  role: z.enum(RESPONDER_ROLES).optional(),
  eventId: id.optional(),
});
export const responderActionSchema = z.object({ responderId: id, note: z.string().max(200).optional(), eventId: id.optional() });
export const backupSchema = z.object({ responderId: id.optional(), reason: z.string().max(200).optional(), eventId: id.optional() });
export const confirmSchema = z.object({ confirmedBy: z.string().min(1).max(60), eventId: id.optional() });
export const resolveSchema = z.object({
  confirmed: z.literal(true),
  confirmedBy: z.string().min(1).max(60),
  note: z.string().max(200).optional(),
  eventId: id.optional(),
});
export const cancelSchema = z.object({ reason: z.string().max(200).optional(), cancelledBy: z.string().max(60).optional(), eventId: id.optional() });

export const responderStatusSchema = z.object({
  status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'BUSY']),
});

export const userResponseSchema = z.object({
  emergencyId: id.optional(),
  watchId: id.optional(),
  eventId: id.optional(),
  response: z.enum(['OK', 'NEED_HELP']),
  timestamp: ts.optional(),
});

export const helloSchema = z.object({
  watchId: id,
  apiKey: z.string().max(200).optional(),
  name: z.string().trim().min(1).max(40).optional(), // shown to the person being helped
  helper: z.boolean().optional(), // false = never alert this watch about nearby emergencies
});

// --- nearby helpers -------------------------------------------------------
export const helperAvailabilitySchema = z.object({ available: z.boolean(), name: z.string().trim().min(1).max(40).optional() });
export const helpRespondSchema = z.object({ emergencyId: id, response: z.enum(['ACCEPT', 'DECLINE']) });
export const HELP_STATUSES = ['MOVING', 'REACHED', 'BACKUP', 'CONFIRMED', 'SAFE'];
export const helpStatusSchema = z.object({ emergencyId: id, status: z.enum(HELP_STATUSES) });

// --- AI structured output -------------------------------------------------
export const aiRoleRecommendation = z.object({ role: z.enum(RESPONDER_ROLES), reason: z.string().max(240) });
export const aiOutputSchema = z.object({
  priority: z.enum(PRIORITIES),
  summary: z.string().min(1).max(400),
  triggerAssessment: z.string().min(1).max(400),
  recommendedRoles: z.array(aiRoleRecommendation).max(6),
  nextAction: z.string().min(1).max(200),
  responsibleRole: z.enum(RESPONDER_ROLES),
  needsBackup: z.boolean(),
  followUpSeconds: z.number().int().min(15).max(900),
  callMessage: z.string().min(1).max(600),
  smsMessage: z.string().min(1).max(320),
});

// Lean variant handed to the Agents SDK as outputType (no length keywords: not every model accepts them in
// strict JSON schema). The response is ALWAYS re-validated with the strict aiOutputSchema above.
export const aiOutputAgentSchema = z.object({
  priority: z.enum(PRIORITIES),
  summary: z.string(),
  triggerAssessment: z.string(),
  recommendedRoles: z.array(z.object({ role: z.enum(RESPONDER_ROLES), reason: z.string() })),
  nextAction: z.string(),
  responsibleRole: z.enum(RESPONDER_ROLES),
  needsBackup: z.boolean(),
  followUpSeconds: z.number().int(),
  callMessage: z.string(),
  smsMessage: z.string(),
});

// Text must never assert a medical diagnosis.
const DIAGNOSIS = /\b(heart attack|cardiac arrest|myocardial|stroke|seizure|epilep|aneurysm|diagnos(?:is|ed|e)|has died|is dead)\b/i;
export function containsDiagnosis(text) {
  return DIAGNOSIS.test(String(text ?? ''));
}

/** Format zod issues compactly for API errors. */
export function issues(err) {
  return (err.issues ?? []).slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
