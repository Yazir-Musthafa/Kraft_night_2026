#!/usr/bin/env node
// Generates the three TwiML Bin scripts needed on a Twilio TRIAL account (trial accounts may only reference
// Twilio-hosted TwiML, not a custom webhook URL). Paste each into Console -> Develop -> TwiML Bins, then put the
// three bin URLs in .env (TWILIO_TWIML_BIN_*). The <Gather action> posts the keypress back to CHER.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import twilio from 'twilio';
import { FOLLOWUP_PROMPTS } from '../src/twilio.js';

const base = (process.env.CHER_PUBLIC_URL ?? '').replace(/\/$/, '');
if (!base.startsWith('https://')) {
  console.error('Set CHER_PUBLIC_URL (public https URL of this server) in .env first.');
  process.exit(1);
}
const INITIAL =
  'This is CHER emergency coordination. A person may need assistance. We have detected an emergency event and have their latest location. ' +
  'Are you near the person and can you reach the location? Press 1 if you can help. Press 2 if you cannot help.';

function script(action, prompt) {
  const vr = new twilio.twiml.VoiceResponse();
  const g = vr.gather({ input: 'dtmf', numDigits: 1, timeout: 10, method: 'POST', action });
  g.say({ language: 'en-US' }, prompt);
  g.pause({ length: 1 });
  g.say({ language: 'en-US' }, prompt);
  vr.say({ language: 'en-US' }, 'We did not receive a response. Goodbye.');
  return vr.toString().replace(/^<\?xml[^>]*\?>/, '');
}

const bins = {
  'cher-initial': { env: 'TWILIO_TWIML_BIN_INITIAL', xml: script(`${base}/twilio/gather`, INITIAL) },
  'cher-followup-status': { env: 'TWILIO_TWIML_BIN_FOLLOWUP_STATUS', xml: script(`${base}/twilio/followup?step=gather`, FOLLOWUP_PROMPTS.STATUS) },
  'cher-followup-confirm': { env: 'TWILIO_TWIML_BIN_FOLLOWUP_CONFIRM', xml: script(`${base}/twilio/followup?step=gather`, FOLLOWUP_PROMPTS.CONFIRM) },
};

mkdirSync('twilio-bins', { recursive: true });
console.log(`Public URL baked into the scripts: ${base}\n`);
for (const [name, b] of Object.entries(bins)) {
  writeFileSync(`twilio-bins/${name}.xml`, `${b.xml}\n`);
  console.log(`=== TwiML Bin "${name}"  ->  .env: ${b.env}=<its URL>\n${b.xml}\n`);
}
console.log('Files also saved in server/twilio-bins/. Twilio Console: Develop -> TwiML Bins -> Create new TwiML Bin.');
