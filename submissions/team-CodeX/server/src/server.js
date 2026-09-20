// CHER server entrypoint: Express + Socket.IO + Redis + scheduler.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { config, configWarnings } from './config.js';
import { logger } from './logging.js';
import * as redis from './redis.js';
import { initSocket, keyMatches } from './socket.js';
import { initResponseChain, resumeAfterRestart } from './responseChain.js';
import * as scheduler from './scheduler.js';
import { healthRoutes } from './routes/healthRoutes.js';
import { emergencyRoutes } from './routes/emergencyRoutes.js';
import { twilioRoutes } from './routes/twilioRoutes.js';
import { demoRoutes } from './routes/demoRoutes.js';
import { nearbyRoutes } from './routes/nearbyRoutes.js';
import { ZodError } from 'zod';
import { issues } from './validation.js';

function apiKeyGuard(req, res, next) {
  if (!config.apiKey) return next();
  return keyMatches(req.get('x-cher-key'), config.apiKey) ? next() : res.status(401).json({ error: 'UNAUTHORIZED' });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(twilioRoutes()); // form-encoded + signature verified; must precede the JSON parser
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', apiKeyGuard);
  app.use(healthRoutes());
  app.use(emergencyRoutes());
  app.use(nearbyRoutes());
  if (config.demoMode) app.use(demoRoutes());
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'INVALID_PAYLOAD', details: issues(err) });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    if (err?.code === 'STORE_UNAVAILABLE') return res.status(503).set('Retry-After', '5').json({ error: 'STORE_UNAVAILABLE', retryable: true });
    if (err?.status && err?.code) return res.status(err.status).json({ error: err.code, message: err.message });
    logger.error('http.unhandled', { message: err?.message });
    return res.status(500).json({ error: 'INTERNAL' });
  });
  return app;
}

/** Build a CHER server. `listen()` starts it; `close()` shuts it down cleanly. */
export function createCher() {
  const app = createApp();
  const httpServer = http.createServer(app);
  const io = initSocket(httpServer);
  initResponseChain();
  let wired = false;

  return {
    app,
    httpServer,
    io,
    async listen(port = config.port) {
      if (!wired) {
        redis.onReady(() => resumeAfterRestart());
        wired = true;
      }
      await redis.connect();
      await new Promise((resolve) => httpServer.listen(port, resolve));
      scheduler.start();
      return httpServer.address().port;
    },
    async close() {
      scheduler.stop();
      await new Promise((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
      await redis.disconnect();
    },
  };
}

async function main() {
  const cher = createCher();
  const port = await cher.listen();
  logger.info('cher.started', { port, demoMode: config.demoMode, contacts: config.contacts.length });
  for (const w of configWarnings(config)) logger.warn('cher.config', { warning: w });
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    logger.info('cher.shutdown', { signal: sig });
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    await cher.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error('cher.fatal', { message: err?.message });
    process.exit(1);
  });
}
