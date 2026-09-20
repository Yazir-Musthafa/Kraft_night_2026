#!/usr/bin/env node
// CHER demo driver: plays the whole closed loop against a running server (CHER_DEMO_MODE=true).
//
//   npm run demo                 automated: simulates the fall AND the responder's key presses
//   npm run demo -- --live       you play the responder on a real phone (Twilio configured); the script narrates
//   npm run demo -- --watch      trigger the fall on the Wear OS app itself (its own detection flow)
//   npm run demo -- --fast       no pauses
//   npm run demo -- --backup     include the "responder needs backup" branch
//   npm run demo -- --url http://localhost:3100
import 'dotenv/config';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BASE = (opt('url', process.env.CHER_DEMO_URL ?? `http://localhost:${process.env.PORT ?? 3000}`)).replace(/\/$/, '');
const PAUSE = flag('fast') ? 0 : 2500;
const headers = { 'content-type': 'application/json', ...(process.env.CHER_API_KEY ? { 'x-cher-key': process.env.CHER_API_KEY } : {}) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const say = (s) => console.log(`\n${c('1;36', '▶')} ${c('1', s)}`);
const note = (s) => console.log(`  ${c('90', s)}`);

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${json.error ?? ''} ${json.message ?? ''}`), { status: res.status, json });
  return json;
}
const post = (p, b = {}) => api('POST', p, b);

function show(e) {
  const bar = '█'.repeat(Math.round(e.coverage.percent / 10)).padEnd(10, '░');
  console.log(`  ${c('33', e.state.padEnd(22))} ${c('32', `${bar} ${e.coverage.percent}%`)}  ${c('35', e.priority)}`);
  console.log(`  responsible: ${c('1', e.responsiblePerson)} (${e.responsibleRole})   next: ${e.nextAction}`);
  console.log(`  contact: ${e.contactStatus}   location shared: ${e.locationShared ? 'yes' : 'no'}   AI: ${e.aiUsed ? 'OpenAI coordinator' : 'deterministic fallback'}`);
}

async function waitForState(id, states, timeoutMs = 10 * 60_000) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    const { emergency } = await api('GET', `/api/emergencies/${id}`);
    if (emergency.state !== last) {
      last = emergency.state;
      show(emergency);
    }
    if (states.includes(emergency.state)) return emergency;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${states.join('/')}`);
}

async function main() {
  const h = await api('GET', '/health').catch(() => null);
  if (!h) throw new Error(`CHER server not reachable at ${BASE}. Start it with: cd server && npm run dev`);
  console.log(c('1;32', 'CHER demo'), `→ ${BASE}   redis:${h.redis.ok ? 'ok' : 'DOWN'}  ai:${h.ai.enabled ? h.ai.model : 'fallback'}  twilio:${h.twilio.mode}`);
  if (!h.demoMode) throw new Error('Server is not in demo mode (set CHER_DEMO_MODE=true).');
  const live = flag('live');

  say('0. Reset demo state');
  await post('/api/demo/reset');
  await sleep(PAUSE / 2);

  say('1. Normal heart rate, then an unusual trend (neutral wording: no diagnosis)');
  let r = await post('/api/demo/health', { scenario: 'normal' });
  note(`normal → ${r.summary.bpm} BPM, trend ${r.summary.trend}, assessment ${r.assessment.state}`);
  await sleep(PAUSE / 2);
  r = await post('/api/demo/health', { scenario: 'trend' });
  note(`trend  → ${r.summary.bpm} BPM, trend ${r.summary.trend}, assessment ${r.assessment.state} (heart rate alone never triggers an SOS)`);
  await sleep(PAUSE);

  let emergencyId;
  if (flag('watch')) {
    say('2. Simulated fall ON THE WATCH: impact → "Are you OK?" → no response → escalation');
    await post('/api/demo/fall', { viaWatch: true });
    note('Do not touch the watch. It asks "Are you OK?", waits, then creates the emergency by itself.');
    const until = Date.now() + 90_000;
    while (!emergencyId && Date.now() < until) {
      const { emergencies } = await api('GET', '/api/emergencies?active=true');
      emergencyId = emergencies[0]?.id;
      if (!emergencyId) await sleep(1000);
    }
    if (!emergencyId) throw new Error('watch did not raise an emergency (is the watch connected? demo mode on?)');
  } else {
    say('2. Simulated fall: impact + fall-like motion + inactivity, "Are you OK?" gets NO response');
    const out = await post('/api/demo/fall', { respond: 'none' });
    emergencyId = out.emergency.id;
    note(`fusion assessment: ${out.assessment.state} (confidence ${out.assessment.confidence}; ${out.assessment.reasons.join(', ')})`);
  }
  console.log(`  emergencyId: ${emergencyId}`);
  await sleep(PAUSE);

  say('3. Backend: Redis stored it, coordinator analysed it, Twilio is calling the responder');
  await sleep(1500);
  show((await api('GET', `/api/emergencies/${emergencyId}`)).emergency);
  await sleep(PAUSE);

  if (live) {
    say('4. LIVE: answer the call on your phone and press 1 to accept');
    await waitForState(emergencyId, ['RESPONDER_ACCEPTED', 'RESPONDER_MOVING', 'PERSON_REACHED']);
    say('5. LIVE: you will get a follow-up call. 3 = still travelling, 1 = reached the person, 2 = need backup');
    await waitForState(emergencyId, ['PERSON_REACHED']);
    say('6. LIVE: the next follow-up asks you to confirm help. 1 = confirmed, 3 = safe and close the emergency');
    await waitForState(emergencyId, ['RESOLVED', 'CANCELLED', 'UNCONFIRMED']);
  } else {
    say('4. Responder presses 1 ("I can help")');
    show((await post('/api/demo/responder', { action: 'accept' })).emergency);
    note('→ RESPONDER_ACCEPTED, location SMS sent, follow-up scheduled in Redis');
    await sleep(PAUSE);

    say('5. Responder is travelling (accepted / travelling is NOT resolution)');
    show((await post('/api/demo/responder', { action: 'moving' })).emergency);
    try {
      await post(`/api/emergencies/${emergencyId}/resolve`, { confirmed: true, confirmedBy: 'demo' });
    } catch (e) {
      note(`✓ resolve attempt refused: ${e.json?.error} (${e.json?.message})`);
    }
    await sleep(PAUSE);

    if (flag('backup')) {
      say('6. Responder asks for BACKUP → CHER hands off to the next responder');
      show((await post('/api/demo/responder', { action: 'backup' })).emergency);
      await sleep(PAUSE);
      say('   Backup responder accepts');
      show((await post('/api/demo/responder', { action: 'accept' })).emergency);
      await sleep(PAUSE);
    }

    say('7. Follow-up call fires ("1 reached / 2 backup / 3 travelling")');
    try {
      await post('/api/demo/responder', { action: 'followup' });
    } catch (e) {
      note(`(${e.message})`);
    }
    await sleep(PAUSE / 2);

    say('8. Follow-up answer 1: the person has been REACHED (this is not resolution)');
    show((await post('/api/demo/responder', { action: 'reached' })).emergency);
    await sleep(PAUSE);

    say('9. Responder explicitly confirms the person has received help');
    show((await post('/api/demo/responder', { action: 'confirm' })).emergency);
    note('→ HELP_CONFIRMED (still not RESOLVED)');
    await sleep(PAUSE);

    say('10. Explicit resolution');
    const who = (await api('GET', `/api/emergencies/${emergencyId}`)).emergency.responsiblePerson;
    show((await post(`/api/emergencies/${emergencyId}/resolve`, { confirmed: true, confirmedBy: who, note: 'Person is safe' })).emergency);
  }

  say('Timeline (stored in Redis)');
  const { timeline } = await api('GET', `/api/emergencies/${emergencyId}/timeline`);
  for (const t of timeline) console.log(`  ${c('90', t.time.slice(11, 19))}  ${t.message}`);
  console.log(`\n${c('1;32', '✓ closed loop complete')}\n`);
}

main().catch((e) => {
  console.error(c('31', `\n✗ ${e.message}`));
  process.exit(1);
});
