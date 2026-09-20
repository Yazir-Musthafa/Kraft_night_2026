// Socket.IO realtime layer. Clients: the Wear OS watch (room watch:<id>) and optional dashboards (room "dashboard").
//
// Client -> server (all support acks {ok, ...}):
//   watch:hello, health:update, location:update, emergency:create, emergency:ack, emergency:cancel,
//   emergency:resolve, emergency:get, user:response, helper:availability, help:respond, help:status, ai:advise
// Server -> client:
//   emergency:created, emergency:updated, emergency:acknowledged, emergency:resolved, emergency:cancelled,
//   health:update, location:update, response:assigned, response:accepted, response:declined, response:moving,
//   response:backup, response:reached, response:unconfirmed, twilio:call, twilio:sms,
//   followup:scheduled, followup:started, followup:missed, responder:status, watch:connection, demo:command,
//   help:request, help:update, help:checkin, help:closed   (nearby-helper flow, see nearby.js)
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { config } from './config.js';
import { bus } from './events.js';
import { logger } from './logging.js';
import { K, setJson, claimOnce } from './redis.js';
import { acknowledgeSchema, emergencyCreateSchema, healthSampleSchema, helloSchema, helperAvailabilitySchema, helpRespondSchema, helpStatusSchema, locationSchema, userResponseSchema, cancelSchema, issues } from './validation.js';
import { processHealth } from './health.js';
import { processLocation } from './location.js';
import { activeEmergencyForWatch, acknowledge, addEvent, ApiError, broadcast, findEmergency, viewOf } from './emergency.js';
import { advise, adviceRequestSchema } from './advice.js';
import { getHelper, helperResume, helperRespond, helperStatus, registerHelper } from './nearbyHelpers.js';
import { triggerEmergency, cancelEmergency, resolveEmergency } from './responseChain.js';

export const EVENTS = {
  emergencyCreated: 'emergency:created',
  emergencyUpdated: 'emergency:updated',
  emergencyResolved: 'emergency:resolved',
  healthUpdate: 'health:update',
  locationUpdate: 'location:update',
};

export const keyMatches = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

let ioRef = null;
let seq = 0;

/** Events that carry high-frequency telemetry go to dashboards only (the watch already has the data). */
const DASHBOARD_ONLY = new Set(['health:update', 'location:update', 'responder:status']);

function fanOut(io, { event, payload, emergencyId, watchId, room }) {
  const body = { ...payload, eventId: `${Date.now()}-${++seq}`, serverTs: Date.now() };
  const rooms = ['dashboard'];
  if (room) rooms.push(room);
  else {
    if (!DASHBOARD_ONLY.has(event) && watchId) rooms.push(`watch:${watchId}`);
    if (emergencyId) rooms.push(`emergency:${emergencyId}`);
  }
  io.to(rooms).emit(event, body);
}

export function initSocket(httpServer) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e5, pingInterval: 10_000, pingTimeout: 8_000 });
  ioRef = io;

  io.use((socket, next) => {
    if (!config.apiKey) return next();
    return keyMatches(socket.handshake.auth?.apiKey, config.apiKey) ? next() : next(new Error('unauthorized'));
  });

  bus.on('publish', (msg) => {
    (async () => {
      let { watchId } = msg;
      if (!watchId && msg.emergencyId) watchId = (await findEmergency(msg.emergencyId).catch(() => null))?.watchId;
      fanOut(io, { ...msg, watchId });
    })().catch((err) => logger.warn('socket.fanout_failed', { message: err?.message }));
  });

  io.on('connection', (socket) => {
    logger.info('socket.connected', { socketId: socket.id });
    if (socket.handshake.auth?.role === 'dashboard') socket.join('dashboard');

    /** Validate -> run -> ack. Never throws to the client; failures come back as {ok:false}. */
    const on = (event, schema, fn) => {
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          let data = payload;
          if (schema) {
            const parsed = schema.safeParse(payload ?? {});
            if (!parsed.success) return reply({ ok: false, error: 'INVALID_PAYLOAD', details: issues(parsed.error) });
            data = parsed.data;
          }
          reply({ ok: true, ...(await fn(data)) });
        } catch (err) {
          logger.warn('socket.handler_failed', { event, code: err?.code, message: err?.message });
          reply({ ok: false, error: err?.code ?? 'INTERNAL', message: err?.code ? err.message : 'Internal error', retryable: err?.code === 'STORE_UNAVAILABLE' });
        }
      });
    };

    on('watch:hello', helloSchema, async ({ watchId, name, helper }) => {
      socket.data.watchId = watchId;
      socket.join(`watch:${watchId}`);
      await setJson(K.connection(watchId), { connected: true, socketId: socket.id, at: Date.now() }, 7 * 24 * 3600);
      // Every watch is a potential nearby helper. The watch states its opt-in on each hello (helper:false = no pop-ups).
      await registerHelper(watchId, { name, available: helper ?? (await getHelper(watchId))?.available });
      const active = await activeEmergencyForWatch(watchId);
      if (active) {
        socket.join(`emergency:${active.id}`);
        await addEvent(active.id, 'WATCH_CONNECTED', 'Watch connected');
      }
      // A helper watch that reconnects gets its open pop-up / ongoing assignment back.
      const help = await helperResume(watchId);
      if (help.assignment?.roomJoin) socket.join(`helpers:${help.assignment.roomJoin}`);
      io.to('dashboard').emit('watch:connection', { watchId, connected: true, at: Date.now() });
      return { watchId, serverTime: Date.now(), activeEmergency: active ? await viewOf(active.id) : null, help };
    });

    const helperWatch = () => {
      if (!socket.data.watchId) throw new ApiError(400, 'NO_HELLO', 'Send watch:hello first');
      return socket.data.watchId;
    };

    on('helper:availability', helperAvailabilitySchema, async ({ available, name }) => {
      const rec = await registerHelper(helperWatch(), { name, available });
      return { available: rec.available, name: rec.name };
    });

    on('help:respond', helpRespondSchema, async (data) => {
      const res = await helperRespond(helperWatch(), data);
      if (res.assignment) socket.join(`helpers:${data.emergencyId}`);
      return res;
    });

    on('help:status', helpStatusSchema, async (data) => helperStatus(helperWatch(), data));

    // Short AI guidance for the watch (heart rate / own emergency / helping someone). Never blocks or throws on model problems.
    on('ai:advise', adviceRequestSchema, async (data) => advise(helperWatch(), data));

    on('health:update', healthSampleSchema, async (data) => {
      const watchId = data.watchId ?? socket.data.watchId ?? config.defaultWatchId;
      const res = await processHealth({ ...data, watchId });
      return { accepted: res.accepted, reason: res.reason, summary: res.summary, assessment: res.assessment };
    });

    on('location:update', locationSchema, async (data) => {
      const watchId = data.watchId ?? socket.data.watchId ?? config.defaultWatchId;
      const res = await processLocation({ ...data, watchId }, { hasActiveEmergency: Boolean(await activeEmergencyForWatch(watchId)) });
      return { accepted: res.accepted, reason: res.reason };
    });

    on('emergency:create', emergencyCreateSchema, async (data) => {
      const watchId = data.watchId ?? socket.data.watchId ?? config.defaultWatchId;
      const res = await triggerEmergency({ ...data, watchId });
      socket.join(`emergency:${res.emergency.id}`);
      return { created: res.created, merged: res.merged, duplicate: res.duplicate, emergency: res.emergency };
    });

    on('emergency:ack', acknowledgeSchema.extend({ emergencyId: emergencyCreateSchema.shape.emergencyId.unwrap() }), async (data) => {
      await acknowledge(data.emergencyId, data.by, data.responderId);
      await broadcast(data.emergencyId, 'emergency:acknowledged', { by: data.by });
      return { emergency: await viewOf(data.emergencyId) };
    });

    on('emergency:cancel', cancelSchema.extend({ emergencyId: emergencyCreateSchema.shape.emergencyId.unwrap() }), async (data) => {
      const res = await cancelEmergency(data.emergencyId, { reason: data.reason ?? 'Cancelled from watch', cancelledBy: data.cancelledBy ?? 'PERSON' });
      return { emergency: res.emergency };
    });

    on('emergency:resolve', null, async (data) => {
      const id = data?.emergencyId;
      if (typeof id !== 'string') throw Object.assign(new Error('emergencyId required'), { code: 'INVALID_PAYLOAD' });
      const res = await resolveEmergency(id, { confirmedBy: 'PERSON', note: 'Person confirmed on watch' });
      return { emergency: res.emergency };
    });

    on('emergency:get', null, async (data) => {
      const id = data?.emergencyId;
      if (typeof id !== 'string') throw Object.assign(new Error('emergencyId required'), { code: 'INVALID_PAYLOAD' });
      return { emergency: await viewOf(id) };
    });

    on('user:response', userResponseSchema, async (data) => {
      const watchId = data.watchId ?? socket.data.watchId ?? config.defaultWatchId;
      if (data.eventId && !(await claimOnce(K.idem('user-response', data.eventId), 3600))) return { duplicate: true };
      if (data.response === 'NEED_HELP') {
        const res = await triggerEmergency({ watchId, eventId: data.eventId, emergencyId: data.emergencyId, triggerType: 'USER_NEEDS_HELP', signals: ['USER_REQUESTED_HELP'], userResponse: 'NEEDS_HELP' });
        socket.join(`emergency:${res.emergency.id}`);
        return { emergency: res.emergency, created: res.created, merged: res.merged };
      }
      logger.info('user.check_in_ok', { watchId });
      const active = await activeEmergencyForWatch(watchId);
      if (active) await addEvent(active.id, 'USER_REPORTED_OK', 'Person reported OK on the watch (emergency stays open until explicitly closed)');
      return { recorded: true };
    });

    socket.on('disconnect', async (reason) => {
      const watchId = socket.data.watchId;
      logger.info('socket.disconnected', { socketId: socket.id, reason });
      if (!watchId) return;
      try {
        await setJson(K.connection(watchId), { connected: false, at: Date.now() }, 7 * 24 * 3600);
        const active = await activeEmergencyForWatch(watchId);
        if (active) await addEvent(active.id, 'WATCH_DISCONNECTED', `Watch disconnected (${reason}); response continues`);
        io.to('dashboard').emit('watch:connection', { watchId, connected: false, at: Date.now() });
      } catch (err) {
        logger.warn('socket.disconnect_record_failed', { message: err?.message });
      }
    });
  });
  return io;
}

/** Emit a command to a connected watch (demo mode). */
export function sendToWatch(watchId, event, payload) {
  ioRef?.to(`watch:${watchId}`).emit(event, { ...payload, serverTs: Date.now() });
}
export const getIo = () => ioRef;
