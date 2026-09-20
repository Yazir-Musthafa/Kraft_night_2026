import './auth-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { fresh } from './helpers.js';
import { createCher } from '../src/server.js';

test('API key: REST and Socket.IO reject clients without the device token; /health stays open', async () => {
  await fresh();
  const cher = createCher();
  const base = `http://127.0.0.1:${await cher.listen(0)}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/emergencies`)).status, 401);
  assert.equal((await fetch(`${base}/api/emergencies`, { headers: { 'x-cher-key': 'wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/emergencies`, { headers: { 'x-cher-key': 'device-token-123' } })).status, 200);
  const bad = connect(base, { transports: ['websocket'], reconnection: false });
  const err = await new Promise((res) => bad.once('connect_error', res));
  assert.match(err.message, /unauthorized/);
  const good = connect(base, { transports: ['websocket'], auth: { apiKey: 'device-token-123' }, reconnection: false });
  await new Promise((res) => good.once('connect', res));
  good.close();
  await cher.close();
});

test('input validation on REST: bad JSON, bad ids, bad bodies -> 4xx, no stack leak', async () => {
  await fresh();
  const cher = createCher();
  const base = `http://127.0.0.1:${await cher.listen(0)}`;
  const h = { 'content-type': 'application/json', 'x-cher-key': 'device-token-123' };
  const r1 = await fetch(`${base}/api/emergencies`, { method: 'POST', headers: h, body: '{bad' });
  assert.equal(r1.status, 400);
  const r2 = await fetch(`${base}/api/emergencies`, { method: 'POST', headers: h, body: JSON.stringify({ triggerType: 'HACK' }) });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, 'INVALID_PAYLOAD');
  const r3 = await fetch(`${base}/api/emergencies/${encodeURIComponent('../etc')}`, { headers: h });
  assert.ok([400, 404].includes(r3.status));
  const r4 = await fetch(`${base}/api/emergencies/E-nope`, { headers: h });
  assert.equal(r4.status, 404);
  const r5 = await fetch(`${base}/api/emergencies/E-nope/resolve`, { method: 'POST', headers: h, body: JSON.stringify({ confirmed: false, confirmedBy: 'x' }) });
  assert.equal(r5.status, 400, 'resolve requires explicit confirmed:true');
  await cher.close();
});
