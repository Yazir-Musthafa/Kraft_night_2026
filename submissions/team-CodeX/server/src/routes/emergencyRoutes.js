// Emergency lifecycle + responder REST API (mirrors what Twilio DTMF and Socket.IO drive).
import { Router } from 'express';
import { config } from '../config.js';
import {
  emergencyCreateSchema, acknowledgeSchema, acceptSchema, responderActionSchema, backupSchema, confirmSchema, resolveSchema, cancelSchema, responderStatusSchema,
} from '../validation.js';
import { acknowledge, broadcast, getEmergency, getTimeline, listEmergencies, viewOf, toView, getEmergencyResponders } from '../emergency.js';
import {
  triggerEmergency, responderAccepts, responderMoving, responderReached, responderNeedsBackup, helpConfirmed, resolveEmergency, cancelEmergency,
  listResponders, setResponderStatus,
} from '../responseChain.js';
import { ApiError } from '../emergency.js';

const ID = /^[A-Za-z0-9._:-]{1,80}$/;

export function emergencyRoutes() {
  const r = Router();

  r.param('id', (req, _res, next, id) => (ID.test(id) ? next() : next(new ApiError(400, 'INVALID_ID', 'Invalid emergency id'))));
  r.param('rid', (req, _res, next, id) => (ID.test(id) ? next() : next(new ApiError(400, 'INVALID_ID', 'Invalid responder id'))));

  r.get('/api/emergencies', async (req, res) => {
    const list = await listEmergencies({ activeOnly: req.query.active === 'true', limit: Math.min(100, Number(req.query.limit) || 50) });
    const views = [];
    for (const e of list) views.push(toView(e, await getEmergencyResponders(e.id)));
    res.json({ emergencies: views });
  });

  r.get('/api/emergencies/:id', async (req, res) => res.json({ emergency: await viewOf(req.params.id) }));

  r.get('/api/emergencies/:id/timeline', async (req, res) => {
    const events = await getTimeline(req.params.id);
    res.json({ emergencyId: req.params.id, timeline: events.map((t) => ({ ...t, time: new Date(t.ts).toISOString() })) });
  });

  r.get('/api/emergencies/:id/coverage', async (req, res) => {
    const e = await getEmergency(req.params.id);
    res.json({ emergencyId: e.id, state: e.state, coverage: e.coverage, responsiblePerson: e.responsiblePerson, responsibleRole: e.responsibleRole, nextAction: e.nextAction });
  });

  r.post('/api/emergencies', async (req, res) => {
    const data = emergencyCreateSchema.parse(req.body);
    const out = await triggerEmergency({ ...data, watchId: data.watchId ?? config.defaultWatchId });
    res.status(out.created ? 201 : 200).json({ created: out.created, merged: out.merged, duplicate: out.duplicate, emergency: out.emergency });
  });

  r.post('/api/emergencies/:id/acknowledge', async (req, res) => {
    const d = acknowledgeSchema.parse(req.body ?? {});
    await acknowledge(req.params.id, d.by, d.responderId);
    await broadcast(req.params.id, 'emergency:acknowledged', { by: d.by });
    res.json({ emergency: await viewOf(req.params.id) });
  });

  r.post('/api/emergencies/:id/accept', async (req, res) => {
    const d = acceptSchema.parse(req.body);
    res.json(await responderAccepts(req.params.id, d.responderId, { role: d.role, via: 'API' }));
  });

  r.post('/api/emergencies/:id/moving', async (req, res) => {
    const d = responderActionSchema.parse(req.body);
    res.json(await responderMoving(req.params.id, d.responderId, { via: 'API' }));
  });

  r.post('/api/emergencies/:id/backup', async (req, res) => {
    const d = backupSchema.parse(req.body ?? {});
    res.json(await responderNeedsBackup(req.params.id, d.responderId, { reason: d.reason ?? 'Backup requested', via: 'API' }));
  });

  r.post('/api/emergencies/:id/reach', async (req, res) => {
    const d = responderActionSchema.parse(req.body);
    res.json(await responderReached(req.params.id, d.responderId, { via: 'API' }));
  });

  r.post('/api/emergencies/:id/confirm', async (req, res) => {
    const d = confirmSchema.parse(req.body);
    res.json(await helpConfirmed(req.params.id, d.confirmedBy));
  });

  r.post('/api/emergencies/:id/resolve', async (req, res) => {
    const d = resolveSchema.parse(req.body);
    res.json(await resolveEmergency(req.params.id, { confirmedBy: d.confirmedBy, note: d.note }));
  });

  r.post('/api/emergencies/:id/cancel', async (req, res) => {
    const d = cancelSchema.parse(req.body ?? {});
    res.json(await cancelEmergency(req.params.id, { reason: d.reason, cancelledBy: d.cancelledBy ?? 'API' }));
  });

  r.get('/api/responders', async (_req, res) => res.json({ responders: await listResponders() }));

  r.post('/api/responders/:rid/status', async (req, res) => {
    const d = responderStatusSchema.parse(req.body);
    res.json({ responder: await setResponderStatus(req.params.rid, d.status) });
  });

  return r;
}
