// Hands-free demo: plays the phone contact so a SIMULATED-Twilio server (no real phone) still shows the whole story.
//
//   node scripts/demo-responder.js                      # http://localhost:3000, accepts 6 s after the contact is called
//   node scripts/demo-responder.js --url http://localhost:3200 --accept 5 --moving 4 --reached 8
//
// When an external phone contact is being called it presses "1" (accept) after --accept seconds, then reports
// moving after --moving and reached after --reached. The person taps I'M SAFE on the watch themselves (add --resolve to
// have the script close it too). Nearby helpers on other watches are never touched: they answer on their own watch.
// Needs CHER_DEMO_MODE=true on the server. DO NOT point this at a server that places real calls: it bypasses the phone.
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const url = (arg('url', process.env.CHER_URL ?? 'http://localhost:3000')).replace(/\/+$/, '');
const acceptAfter = Number(arg('accept', 6));
const movingAfter = Number(arg('moving', 4));
const reachedAfter = Number(arg('reached', 8));
const resolve = process.argv.includes('--resolve');
const headers = { 'content-type': 'application/json', ...(process.env.CHER_API_KEY ? { 'x-cher-key': process.env.CHER_API_KEY } : {}) };

const seen = new Map(); // emergencyId -> { stage, since }
const say = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
const call = async (action, emergencyId, responderId) => {
  const res = await fetch(`${url}/api/demo/responder`, { method: 'POST', headers, body: JSON.stringify({ action, emergencyId, responderId }) });
  if (!res.ok) say(`  ${action} refused: ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.ok;
};

let busy = false;
async function tick() {
  if (busy) return; // a slow request must not start a second, overlapping pass (it would answer twice)
  busy = true;
  try {
    await pass();
  } finally {
    busy = false;
  }
}

async function pass() {
  const res = await fetch(`${url}/api/emergencies`, { headers });
  const { emergencies } = await res.json();
  for (const e of emergencies.filter((x) => !['RESOLVED', 'CANCELLED'].includes(x.state))) {
    const contact = e.responders.find((r) => !r.responderId.startsWith('H:'));
    if (!contact) continue;
    const s = seen.get(e.id) ?? { stage: 'waiting', since: Date.now() };
    const secs = (Date.now() - s.since) / 1000;
    if (s.stage === 'waiting' && contact.status === 'CONTACTING' && secs >= acceptAfter) {
      say(`${contact.name} answers the call and presses 1 (accept) for ${e.id.slice(0, 10)}`);
      if (await call('accept', e.id, contact.responderId)) Object.assign(s, { stage: 'accepted', since: Date.now() });
    } else if (s.stage === 'accepted' && secs >= movingAfter) {
      say(`${contact.name} is on the way`);
      if (await call('moving', e.id, contact.responderId)) Object.assign(s, { stage: 'moving', since: Date.now() });
    } else if (s.stage === 'moving' && secs >= reachedAfter) {
      say(`${contact.name} reached the person`);
      if (await call('reached', e.id, contact.responderId)) Object.assign(s, { stage: resolve ? 'reached' : 'done', since: Date.now() });
    } else if (s.stage === 'reached' && secs >= 5) {
      say('closing the emergency');
      await call('resolve', e.id, contact.responderId);
      s.stage = 'done';
    }
    seen.set(e.id, s);
  }
}

say(`demo responder watching ${url} (accept ${acceptAfter}s, moving +${movingAfter}s, reached +${reachedAfter}s${resolve ? ', then resolve' : ''}). Ctrl+C to stop.`);
setInterval(() => tick().catch((err) => say(`waiting for server: ${err.message}`)), 1000);
