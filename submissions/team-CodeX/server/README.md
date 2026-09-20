# CHER: Coordinated Human Emergency & Response

> CHER is **not** "SOS → SMS". It is a closed loop:
> **detect → verify → escalate → contact → locate → coordinate → follow up → backup/handoff → verify response → resolve.**
>
> Success is *not* "an SOS was sent". Success is: **a responsible human accepted the emergency, the response was coordinated, the person's situation was explicitly confirmed, and the emergency was resolved.**

This is a prototype. It reports *unusual signals* ("unusual heart-rate pattern", "possible fall", "prolonged inactivity"). It never diagnoses a medical condition, and it is not a certified medical or safety device. Do not rely on it for real emergencies.

---

## 1. Concept

| Stage | What happens | Where |
|---|---|---|
| Detect | Heart-rate trend, impact/fall-like motion, inactivity, manual SOS | Wear OS app |
| Verify | "Are you OK?" check; never an SOS from one sensor reading | Wear OS app |
| Escalate | No answer + corroborating signals → last-chance cancel → emergency | Wear OS app |
| Contact | Twilio call + SMS to the first configured responder | server |
| Locate | Coordinates (no map SDK) in SMS; refreshed before follow-ups | server |
| Coordinate | OpenAI Agents SDK "Response Coordinator" (deterministic fallback) | server |
| Follow up | Persistent Redis scheduler places follow-up calls (1 reached / 2 backup / 3 travelling) | server |
| Backup / handoff | Declined, silent or "needs backup" → next responder → else `UNCONFIRMED` | server |
| Resolve | Only from `PERSON_REACHED`/`HELP_CONFIRMED` with **explicit** confirmation | server |

Every active emergency always has a `responsiblePerson`, `responsibleRole` and `nextAction`. If nobody can be found, the state becomes `UNCONFIRMED` with the next action "call local emergency services or check on the person directly". It is never silently dropped.

## 2. Architecture

```
┌──────────────────┐  Socket.IO (+ offline outbox)   ┌────────────────────────────────────────────┐
│  Wear OS watch   │ ─────────────────────────────▶  │  Express + Socket.IO  (server/src)         │
│  Kotlin, XML UI  │ ◀─────────────────────────────  │                                            │
│  Health Services │   emergency:* / response:* ...  │  emergency.js   state machine + timeline   │
│  accel / gyro    │                                 │  responseChain  responsibility/backup      │
│  android.location│                                 │  scheduler.js   persistent follow-ups      │
└──────────────────┘                                 │  ai.js          OpenAI Agents SDK + Zod    │
                                                     │  twilio.js      voice/SMS/TwiML/webhooks   │
   Human responder ◀── phone call / SMS ─────────────│                                            │
   presses 1/2/3   ─── DTMF / SMS reply ───────────▶ │  Redis = the only state store              │
                                                     └────────────────────────────────────────────┘
```

## 3. Technology stack (fixed)

Backend: Node.js, Express, Socket.IO, Redis, `@openai/agents` + Zod, Twilio Node SDK, dotenv.
Watch: Kotlin, native Android/Wear OS APIs, Wear OS Health Services, Android sensors and `android.location`, XML/View UI.

Deliberately **not** used: React/Flutter/Compose, Firebase, any other database, any map/routing API.

## 4. Project structure

```
CHER/
├── server/
│   ├── package.json  .env.example  .gitignore  README.md
│   ├── scripts/            demo.js (full demo driver), check-syntax.js
│   ├── test/               82 tests (node:test)
│   └── src/
│       ├── server.js       Express + Socket.IO bootstrap, graceful shutdown
│       ├── config.js       env parsing + tunable thresholds
│       ├── redis.js        connection, key schema, helpers, locks
│       ├── socket.js       realtime events, acks, reconnect sync
│       ├── emergency.js    state machine, timeline, coverage, idempotent creation
│       ├── health.js       heart-rate intake and summaries
│       ├── sensors.js      HR trend + signal fusion (pure)
│       ├── location.js     location intake, rate limiting, plain coordinates
│       ├── ai.js           Response Coordinator agent, tools, fallback
│       ├── twilio.js       SMS, calls, TwiML, webhook signature validation
│       ├── responseChain.js  responsibility, accept/decline/backup/handoff, follow-ups
│       ├── scheduler.js    Redis-backed scheduler (restart-safe)
│       ├── validation.js   Zod schemas
│       ├── logging.js      structured logs with redaction
│       └── routes/         healthRoutes  emergencyRoutes  twilioRoutes  demoRoutes
└── watch/                  Gradle Android project (AGP 9.4, Kotlin, Wear OS)
    └── app/src/main/java/com/cher/watch/
        ├── MainActivity.kt   CherApp.kt
        ├── ui/health/      HeartRateAnalyzer  HeartRateMonitor (Health Services + sensor fallback)
        ├── ui/sensors/     MotionAnalyzer  MotionMonitor
        ├── ui/location/    LocationProvider
        ├── ui/socket/      SocketClient  PendingStore (durable outbox)
        ├── ui/emergency/   EmergencyController  SignalFusion  DemoController  HoldButton
        ├── ui/services/    CherRuntime  MonitoringService  PowerModeManager  BatteryMonitor  Notifier
        ├── ui/models/      Models.kt
        └── utils/          CherConfig (all thresholds)  Prefs  PermissionHelper  Haptics
```

## 5. Prerequisites

- Node.js 20+ (tested on Node 26)
- Redis 6+ running locally (or reachable via `REDIS_URL`)
- JDK 17, Android SDK (platform 37 was used here) and a Wear OS emulator (or a watch)
- Optional for the real thing: an OpenAI API key, a Twilio account, and a public HTTPS tunnel

## 6. Node installation

```bash
cd server
npm install
```

## 7. Redis setup

```bash
brew install redis            # macOS (Linux: apt install redis-server)
brew services start redis     # or:  redis-server
redis-cli ping                # → PONG
# or Docker:  docker run -d --name cher-redis -p 6379:6379 redis:7
```

All CHER keys live under the `cher:` prefix (configurable with `CHER_REDIS_PREFIX`), so CHER can share a Redis with other apps. Key layout:

```
cher:emergency:{id}              JSON: state, responsible person/role/next action, coverage, retries...
cher:emergency:{id}:events       list: the timeline
cher:emergency:{id}:responders   hash: per-responder state and attempt counters
cher:emergency:{id}:followups    hash: scheduled/finished follow-up + retry items
cher:emergencies:active|all      set / sorted set indexes
cher:followups:due               sorted set (score = due time) polled by the scheduler
cher:responder:{id}              responder availability
cher:watch:{id}:health           recent heart-rate samples (list, capped)
cher:watch:{id}:location         latest location (TTL)
cher:watch:{id}:connection       socket connection status
cher:call:{cid}                  server-side context for one Twilio call (webhook trust anchor)
cher:idem:*                      idempotency / dedupe claims (SET NX EX)
```

## 8. Environment variables

Copy the template and fill it in. **The real `.env` is gitignored. Never commit or paste secrets into source.**

```bash
cd server && cp .env.example .env
```

| Variable | Put your… | Notes |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI key | blank ⇒ deterministic fallback only |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | blank ⇒ calls/SMS are **simulated** |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | also used to verify webhook signatures |
| `TWILIO_PHONE_NUMBER` | Twilio number (E.164) | the caller ID |
| `EMERGENCY_CONTACT_1` | responder phone (E.164) | first responder. `_2`, `_3` optional (backup chain) |
| `EMERGENCY_CONTACT_n_NAME` | display name | e.g. `Abhishek` |
| `CHER_PUBLIC_URL` | public HTTPS URL of this server | Twilio must reach `/twilio/*` |
| `TWILIO_MAX_RETRIES`, `TWILIO_RETRY_INTERVAL_SECONDS` | retry policy | default 3 / 120 |
| `CHER_FOLLOWUP_INTERVAL_SECONDS`, `CHER_FOLLOWUP_MAX_RETRIES` | follow-up policy | default 120 / 3 |
| `CHER_API_KEY` | optional device token | if set, REST (`x-cher-key`) and Socket.IO (`auth.apiKey`) require it |
| `CHER_LOCATION_URL_TEMPLATE` | optional link template | `https://…/?q={lat},{lng}`; empty ⇒ coordinates only |
| `CHER_DEMO_MODE` | `true` for demos | enables `/api/demo/*` |
| `PORT`, `REDIS_URL`, `CHER_REDIS_PREFIX`, `LOG_LEVEL` | | |
| `CHER_SERVER_URL` | `http://10.0.2.2:3000` | what the *watch* uses (emulator → host machine) |

None of the secret variables ever leave the server. The watch only knows the server URL.

## 9. OpenAI configuration

1. Put `OPENAI_API_KEY` in `server/.env` (optionally `OPENAI_MODEL`, default `gpt-4.1-mini`).
2. The **CHER Response Coordinator** (an `@openai/agents` `Agent`) receives structured facts only (trigger, signals, heart-rate summary, *rounded* location, responder availability, recent timeline) and returns a Zod-validated object: `priority, summary, triggerAssessment, recommendedRoles, nextAction, responsibleRole, needsBackup, followUpSeconds, callMessage, smsMessage`.
3. Its **only** way to act is a fixed tool set with validated inputs: `getEmergencyState, getLatestHealthSummary, getLatestLocation, getResponderAvailability, assignResponder, requestBackup, updateEmergencyStatus, sendEmergencySMS, startTwilioCall, scheduleFollowUp, markResponseProgress, resolveEmergency`. Tools are bound to *one* emergency. In the initial analysis, contact tools are refused because the response chain already contacts the responder. `updateEmergencyStatus` can never change the state; `resolveEmergency` is refused unless a human already confirmed help.
4. **Guard rails:** output that fails Zod, mentions a diagnosis (heart attack, stroke, …), times out (`CHER_AI_TIMEOUT_MS`) or errors is discarded and the deterministic analysis is used. AI can raise, never lower, the rule-based priority floor. Manual SOS never waits for the AI.
5. Tracing is disabled, and phone numbers are never sent to the model. Heart-rate summary and rounded (~100 m) location are.

## 10. Twilio configuration

1. Create a Twilio account and a voice+SMS capable number. On a trial account, verify the responder's phone number.
2. Fill the four `TWILIO_*`/`EMERGENCY_CONTACT_1` variables.
3. Expose the server over HTTPS and set it as `CHER_PUBLIC_URL`, for example:
   ```bash
   ngrok http 3000          # or: cloudflared tunnel --url http://localhost:3000
   ```
4. Outbound calls set their own webhook URLs per call, so nothing else is needed in the console. *Optional:* point the number's SMS webhook at `POST <CHER_PUBLIC_URL>/twilio/sms` to allow SMS replies (`YES`, `NO`, `MOVING`, `REACHED`, `BACKUP`) when voice fails.
5. Webhooks: `POST /twilio/voice`, `/twilio/gather`, `/twilio/followup`, `/twilio/status`, `/twilio/sms`. All are **signature-verified** (fail closed when `TWILIO_AUTH_TOKEN` is set). Emergency and responder context comes from a server-side call record keyed by an unguessable id. Arbitrary emergency IDs in requests are never trusted.

Call flow: `1` = I can help (accept → location SMS → follow-up scheduled), `2` = cannot help (→ next responder), no answer → retry per policy (never infinite), then hand off. Follow-up call: `1` reached, `2` need backup, `3` still travelling. After *reached*, a confirmation call: `1` help received, `2` backup, `3` safe → close.

### Twilio TRIAL accounts (important)

A trial account only lets an outbound call reference **Twilio-hosted** TwiML. Verified against a live trial account: a custom `url`, inline `twiml` and a TwiML App `applicationSid` are all rejected (`400 … trial accounts have limited parameter access`), while Twilio's own template URL works. CHER therefore has a **trial mode**:

1. `cd server && npm run twilio:bins`. It prints three scripts, with your `CHER_PUBLIC_URL` baked into each `<Gather action>`.
2. Twilio Console → Develop → **TwiML Bins** → create three bins and paste one script into each.
3. Put each bin's URL into `.env` as `TWILIO_TWIML_BIN_INITIAL`, `TWILIO_TWIML_BIN_FOLLOWUP_STATUS`, `TWILIO_TWIML_BIN_FOLLOWUP_CONFIRM`, then restart.

In this mode the call carries only `to/from/url`. Keypresses come back through the bin's `<Gather action>`, and CHER finds its record from the `CallSid`. There is no `statusCallback` on trial, so an unanswered call is detected by the scheduler timeout (`TWILIO_RETRY_INTERVAL_SECONDS`). Trial also blocks custom SMS to India (error 5720), so on accept CHER **reads the coordinates aloud** on the call and counts that as "location shared".

Without Twilio credentials the server runs in **simulated mode**: every call/SMS is recorded in the timeline and Socket.IO events as `simulated`, and responders' key presses can be played with `/api/demo/responder`.

## 11. Running the backend

```bash
cd server
npm install
npm run dev          # node --watch;  npm start for plain node
curl localhost:3000/health
```

## 12. Creating / running the Wear OS project

The Gradle project is already generated in `watch/` (AGP 9.4.1, Gradle 9.6, Kotlin via AGP built-in support, compileSdk 37, minSdk 30).

```bash
cd watch
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug           # installs to the running emulator/watch
./gradlew testDebugUnitTest      # 14 detection unit tests
```

`watch/local.properties` must contain `sdk.dir=/path/to/Android/sdk` (Android Studio writes it; it is gitignored).

Server URL for the watch (never hard-code production URLs):
```bash
./gradlew installDebug -Pcher.serverUrl=http://192.168.1.20:3000   # build-time
adb shell am start -n com.cher.watch/.MainActivity --es cher_server_url http://192.168.1.20:3000   # runtime
```
Default is `http://10.0.2.2:3000` (the host machine as seen from the emulator). Cleartext HTTP is only enabled in the **debug** build; release builds require HTTPS.

## 13. Emulator configuration

Use a **Wear OS** system image (the project was tested on `Wear_OS_XL_Round`, API 37).

```bash
$ANDROID_HOME/emulator/emulator -list-avds
$ANDROID_HOME/emulator/emulator -avd Wear_OS_XL_Round
adb devices
```
The emulator has no real heart-rate strap or fall physics. Health Services provides synthetic heart-rate values, and **demo mode** (below) simulates everything else. Set a location with `adb emu geo fix -122.084 37.422`.

## 14. ADB commands

```bash
adb devices
adb install -r watch/app/build/outputs/apk/debug/app-debug.apk

# grant permissions non-interactively (the app also asks, with explanations)
adb shell pm grant com.cher.watch android.permission.ACCESS_FINE_LOCATION
adb shell pm grant com.cher.watch android.permission.ACCESS_COARSE_LOCATION
adb shell pm grant com.cher.watch android.permission.POST_NOTIFICATIONS
adb shell pm grant com.cher.watch android.permission.health.READ_HEART_RATE   # Wear OS 6+/API 36+
adb shell pm grant com.cher.watch android.permission.BODY_SENSORS             # older Wear OS

adb emu geo fix -122.084 37.422                                    # set GPS
adb shell am start -n com.cher.watch/.MainActivity                 # launch
adb shell am start -n com.cher.watch/.MainActivity --ez cher_demo true --es cher_action fall
#   cher_action: sos | fall | impact | inactivity | hr_high | hr_low | hr_trend | hr_normal | ok | help
adb shell input swipe 240 410 240 410 2300                         # long-press = hold for SOS (480px screen)
adb logcat -s CHER/Runtime CHER/Socket CHER/Controller CHER/Service CHER/HeartRate CHER/Location
adb exec-out screencap -p > shot.png
adb shell pm clear com.cher.watch                                  # reset app state and permissions
# physical watch over Wi-Fi: adb connect <watch-ip>:<port>  and use your LAN URL for the server
# alternative to 10.0.2.2:  adb reverse tcp:3000 tcp:3000  then --es cher_server_url http://localhost:3000
```

## 15. Demo mode

Set `CHER_DEMO_MODE=true` in `server/.env`, then enable **Settings → Demo mode** on the watch (or `--ez cher_demo true`). Demo mode injects *simulated* signals into the same pipeline real sensors use (analyzer → fusion → check-in → escalation → backend), labelled "Demo" on screen and `demo:true` to the server. Check-in timers shorten to 12 s + 5 s.

Watch demo controls (Settings): NORMAL / HIGH / LOW HR, HR TREND UP, SIM IMPACT, **SIM FALL**, SIM INACTIVITY.
Server demo API: `POST /api/demo/health {scenario: normal|high|low|trend}`, `/api/demo/fall {viaWatch?, respond?: none|ok|help}`, `/api/demo/emergency`, `/api/demo/responder {action: accept|decline|moving|backup|reached|confirm|resolve|followup}`, `/api/demo/reset`.

### Demo timing and coverage rules

With `CHER_DEMO_MODE=true` the whole response chain runs on a short clock so a judge can watch every step in a few minutes. This is decided in **one place** (`config.timing`), through the same Redis scheduler as production: no separate timer system, and it survives a server restart.

| | Demo (`CHER_DEMO_MODE=true`) | Production |
|---|---|---|
| Gap between calls / follow-ups | `CHER_DEMO_CALL_INTERVAL_SECONDS` (default **20 s**) | `CHER_FOLLOWUP_INTERVAL_SECONDS` (default 120 s) |
| Nearby helpers' time to accept | same 20 s | `CHER_NEARBY_WAIT_SECONDS` |
| "No answer" decision after a call | `CHER_DEMO_OUTREACH_TIMEOUT_SECONDS` (45 s: a phone rings ~30 s, so declaring it earlier would double-call) | `TWILIO_RETRY_INTERVAL_SECONDS` |

**Coverage measures response progress, not activity.** Placing a call or SMS adds nothing. It moves only when a human actually responds:

| Event | Coverage |
|---|---|
| Emergency detected and recorded | 10% |
| Responder answers and accepts (keypress **1**, or accepted on a nearby watch), location delivered | 55% |
| Follow-up answered "still travelling" (**3**) | 65% |
| Follow-up answered "reached the person" (**1**) | 90% |
| Confirmation answered "help received" (**1**) | 100% (state `HELP_CONFIRMED`) |
| Explicit close | `RESOLVED` (never automatic, even at 100%) |

Every payload also carries `countdown {label, seconds}` (e.g. "Next follow-up call, 18 s"), `progress` (an ordered done/current/pending/skipped checklist) and `nearbyEnabled`. An external phone contact acting as first responder is shown as **Emergency Contact**; a nearby watch helper as **First Responder**.

### Demo script

```bash
cd server
npm run demo                       # fully automated closed loop (simulated fall + simulated responder)
npm run demo -- --backup           # include the "needs backup" handoff
npm run demo -- --watch            # the fall is detected on the watch itself
npm run demo -- --live             # with real Twilio: YOU play the responder on your phone
npm run demo -- --fast --url http://localhost:3100
```

Suggested live story (10 min):
1. Watch on the main screen: monitoring ACTIVE, live BPM, CONNECTED. Terminal 1 shows the server, terminal 2 runs `npm run demo -- --watch --live`.
2. HR trend up → CHER notes it, no SOS (single signals never trigger).
3. Watch: **impact → "Are you OK?"** → do nothing → "No response" countdown → **EMERGENCY ACTIVE**.
4. Terminal: Redis-backed emergency, OpenAI/fallback analysis, Twilio call to your phone. Press **1**.
5. Watch flips to the response screen (responder name, status, coverage climbing, next action). Location SMS arrives.
6. Follow-up call: **3** travelling → later **1** reached. Then the confirmation call: **3** safe → **RESOLVED** screen.
7. `GET /api/emergencies/<id>/timeline` shows every step.

## 16. Emergency flow

States: `ACTIVE → RESPONDER_SEARCHING → RESPONDER_ACCEPTED → RESPONDER_MOVING → PERSON_REACHED → HELP_CONFIRMED → RESOLVED`, plus `RESPONDER_NEEDS_BACKUP`, `CANCELLED`, `UNCONFIRMED`. Illegal transitions are rejected (HTTP 409); `RESOLVED` is reachable only from `HELP_CONFIRMED`.

**Response coverage** (weighted responsibilities, exposed on every payload and `GET /api/emergencies/:id/coverage`): recorded 10, responder contacted 10, location shared 10, responder accepted 25, en route 10, person reached 25, help confirmed 10, plus 8 per extra assigned role. Losing the responder (backup) lowers it.

**Idempotency:** same `emergencyId`/`eventId` ⇒ same emergency; a new trigger while one is active is merged; Twilio callbacks and DTMF are deduplicated; the scheduler claims items atomically.

REST: `GET /health`, `GET /api/emergencies[?active=true]`, `GET /api/emergencies/:id`, `…/timeline`, `…/coverage`, `POST /api/emergencies`, `POST …/:id/{acknowledge,accept,moving,backup,reach,confirm,resolve,cancel}`, `POST /api/health`, `POST /api/location`, `GET /api/responders`, `POST /api/responders/:id/status`.

Socket.IO (client→server, all acked): `watch:hello, health:update, location:update, emergency:create, emergency:ack, emergency:cancel, emergency:resolve, emergency:get, user:response`. Server→client: `emergency:created|updated|acknowledged|resolved|cancelled, health:update, location:update, response:assigned|accepted|declined|moving|backup|reached|unconfirmed, twilio:call, twilio:sms, followup:scheduled|started|missed, responder:status, watch:connection, demo:command`. Every event carries `eventId` + `serverTs` and the full emergency view. Dashboards connect with `auth: {role:'dashboard'}`.

**Watch behaviour:** `NORMAL → POSSIBLE_ANOMALY → VERIFYING → ESCALATING → ACTIVE_EMERGENCY`. Heart rate needs 5 consecutive abnormal samples, and even then only asks "Are you OK?" after ~2 min on its own. An impact must be free-fall-preceded, very hard, or followed by stillness. Escalation needs a failed check-in *and* corroborating signals. Manual SOS (hold 1.5 s) bypasses all of it. An SOS is created locally first, persisted in an outbox and retried until the server acknowledges it.

Power modes: **NORMAL** (50 Hz motion, continuous HR, location every 2 min), **SAFE** (≤20 % battery or forced: 10 Hz motion, no gyro, HR 20 s on / 100 s off, location every 10 min), **EMERGENCY** (location every 5 s, continuous HR, comms first).

## 16b. Nearby helpers (watch-first alerts)

Before anybody is phoned, **other CHER watches close to the person get a pop-up** ("Someone nearby needs help, 300 m, south"). The phone contact chain only starts when nobody nearby accepts, everybody declines, or nobody is in range.

```
SOS ─▶ eligible watches in radius ─▶ pop-up (help:request) ──accept──▶ live location + compass + map on the helper's watch
            │ none                          │ decline all / timeout
            └────────────▶ call the emergency contact (Twilio) ◀────────┘
```

- **Eligible** = connected, "Help others nearby" on, a location younger than 10 min, inside `CHER_NEARBY_RADIUS_M`, not in its own emergency, not already helping. Closest first, at most `CHER_NEARBY_MAX_ALERTED`.
- **Privacy:** before accepting the helper only sees distance and a rough direction. The exact location is sent after **CAN HELP**, then follows the person live (`help:update`).
- **Guidance on the watch:** compass arrow, a vector mini-map (works offline, no map SDK) and an actions page. It is a straight-line guide, not street routing.
- **A helper is an ordinary responder** (`H:<watchId>`), so coverage, backup, follow-ups and resolution are unchanged. Follow-ups for a helper are a check-in on the watch ("Still on your way?"), never a phone call; a silent helper escalates to the phone contact.
- **Opt-outs:** the person's **Nearby Responder Alerts** setting (`nearbyAlerts:false` in `emergency:create`; timeline `NEARBY_SKIPPED`) and each watch's **Nearby help** switch (`watch:hello.helper:false`).

| Variable | Default | Meaning |
|---|---|---|
| `CHER_NEARBY_ENABLED` | `true` | master switch |
| `CHER_NEARBY_RADIUS_M` | `1500` | how far away a helper may be |
| `CHER_NEARBY_WAIT_SECONDS` | `45` | how long helpers have to accept (demo mode uses the shorter demo timing) |
| `CHER_NEARBY_MAX_ALERTED` / `_MAX_RESPONDERS` | `5` / `2` | pop-ups sent / helpers allowed on the way |
| `CHER_NEARBY_LOCATION_MAX_AGE_SECONDS` | `600` | older locations do not count as "nearby" |
| `CHER_NEARBY_CHECKIN_SECONDS` | `60` | time a helper has to answer a check-in |

Socket events: client -> `helper:availability`, `help:respond {emergencyId, response: ACCEPT|DECLINE}`, `help:status {emergencyId, status: MOVING|REACHED|BACKUP|CONFIRMED|SAFE}`; server -> `help:request`, `help:update`, `help:checkin`, `help:closed`. REST: `GET /api/helpers`. Demo: `POST /api/demo/helper {watchId, name, distanceM|latitude+longitude, respond?, status?}` adds a virtual helper without a device.

### Testing with a second (nearby) watch on your own machine

A Wear OS app cannot run inside a web page, so a friend's website simulator cannot host this code, and it could not reach your server anyway. Run a **second Wear OS emulator** next to the first; both talk to the same server, one is the person, the other the nearby helper.

```bash
avdmanager create avd -n Wear_OS_Helper -k "system-images;android-37.0;android-wear-signed;arm64-v8a" -d wearos_xl_round
emulator -avd Wear_OS_Helper -port 5558 &               # the first emulator stays on 5554 / or -port 5556
adb -s emulator-5558 install -r watch/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5558 shell pm grant com.cher.watch android.permission.ACCESS_FINE_LOCATION
adb -s emulator-5558 shell am start -n com.cher.watch/.MainActivity \
    --es cher_server_url http://10.0.2.2:3000 --es cher_watch_id watch-2 --es cher_helper_name Riya
adb -s emulator-5556 emu geo fix -122.084 37.4220       # the person
adb -s emulator-5558 emu geo fix -122.084 37.4247       # the helper, ~300 m north
adb -s emulator-5556 shell am start -n com.cher.watch/.MainActivity --es cher_action sos   # -> pop-up on the helper's watch
```
Each watch needs its own `--es cher_watch_id`. Revoke `READ_HEART_RATE` on emulators (`adb shell pm revoke ...`) or their synthetic heart rate will raise real check-ins. Extras: `cher_broadcast` (person's opt-out), `cher_nearby` (helper's opt-out), `cher_action help_accept|help_decline|help_arrived`.

## 17. Testing

```bash
cd server
npm run check      # syntax of every file, package.json, env validation
npm test           # 82 tests, no network: in-memory Redis, fake Twilio client, fake OpenAI model
cd ../watch && ./gradlew testDebugUnitTest
```

Backend coverage: manual & automatic SOS, abnormal HR (incl. single-spike immunity), fall detection, "I'm OK", "need help", no response, accept/decline/timeout, retries, backup, handoff, follow-ups, Redis persistence and restart recovery (plus one test against a real local Redis, skipped if none), Socket.IO reconnect, duplicate events, explicit resolution, cancellation, webhook signatures, **OpenAI failure / invalid output / diagnosis text / timeout**, the real Agents SDK loop against a fake model, **Twilio failure**, **Redis failure** (503 + degraded SMS), auth, validation, log redaction.

## 18. Security

- Secrets exist only in `server/.env` (gitignored) and `process.env`. Nothing secret is in Kotlin, the APK, Socket.IO payloads, the README or logs (logs redact secrets and mask phone numbers).
- The watch talks only to the CHER backend. It has no OpenAI/Twilio/Redis credentials.
- Twilio webhooks are signature-verified; context comes from unguessable server-side call records.
- All inputs (REST, Socket.IO, AI output) are Zod-validated. The AI has no shell, file, HTTP or env access, only the tools above.
- `CHER_API_KEY` is a *device token*: compiled into an APK it is not a secret. It stops casual abuse; a real deployment needs per-device credentials, TLS and rate limiting.
- Debug build allows cleartext HTTP to the emulator host; release build does not.

## 19. Known limitations

- Prototype. Detection thresholds are conservative defaults, **not** clinically validated, and will produce false alarms and misses.
- The emulator has no real fall/heart-rate physics; demo mode substitutes simulated signals (clearly labelled).
- Real Twilio calls/SMS and the real OpenAI API were **not** exercised in development (no credentials available). They are covered by a fake Twilio client, a fake Agents SDK model and simulated mode. Expect to tune on first live run (trial-account restrictions, voice, tunnel URL).
- Single server process: per-emergency locking is in-process. Multiple instances would need Redis locks. Redis is the source of truth, so a restart resumes follow-ups, but an in-flight step may run twice (at-least-once; handlers are idempotent).
- Android decides background execution. If the foreground service cannot start (permission denied, battery restrictions), monitoring runs only while the app process lives, and the UI says **DEGRADED** instead of claiming continuous monitoring. Long-inactivity detection needs the off-body sensor and is otherwise disabled.
- Heart-rate permission: Wear OS 6+ (API 36+) uses `android.permission.health.READ_HEART_RATE`; older uses `BODY_SENSORS`.
- One watch/person, up to three responders. No user accounts, dashboard UI or map (by design).
- Location links are coordinates unless you configure `CHER_LOCATION_URL_TEMPLATE`.

## 20. Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :3000` | another process holds the port: `lsof -nP -iTCP:3000 -sTCP:LISTEN`; run CHER with `PORT=3100` and start the app with `--es cher_server_url http://10.0.2.2:3100` |
| `/health` → 503 `degraded` | Redis unreachable: `redis-cli ping`, check `REDIS_URL` |
| Watch shows OFFLINE | server not running, wrong URL (use `10.0.2.2` on the emulator), or `CHER_API_KEY` mismatch (`-Pcher.apiKey=…`) |
| Twilio calls don't arrive | `CHER_PUBLIC_URL` unreachable/HTTP, unverified number on a trial account, `EMERGENCY_CONTACT_1` not E.164; check `/health` → `twilio.mode` |
| Webhooks return 403 | wrong `CHER_PUBLIC_URL` (must equal the URL Twilio calls, including https and no trailing path) or wrong auth token |
| Heart rate "permission denied" | grant Heart rate permission (Settings → PERMISSIONS) |
| Heart rate "No heart-rate sensor" | device/emulator lacks it: use demo mode |
| Location UNAVAILABLE | `adb emu geo fix <lon> <lat>` or enable location on the watch |
| `Gradle` can't find SDK | create `watch/local.properties` with `sdk.dir=…` |
| AI never used | check `/health` → `ai.enabled`; unset key ⇒ fallback by design. Look for `ai.fallback` log lines |
