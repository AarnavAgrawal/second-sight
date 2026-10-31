# Second Sight backend API (for the frontend)

The frontend talks to two things:

1. **The bridge** (HTTP, `http://localhost:8787`, CORS open): airport picker, session, clearances, voice, CIC messages, websocket grants.
2. **Terse actors** (websockets, URL from `GET /grant`): all live state. **No polling.**

Types referenced below are in [`shared/types.ts`](../shared/types.ts) (CLAUDE.md section 7). All timestamps are epoch milliseconds. Import the types directly (`import type { TrafficEntry } from "../shared/types.ts"`); they have no runtime dependencies.

---

## Running the backend

```powershell
# 1. Terse actors (local runtime only exists for Linux, so it runs in WSL Ubuntu)
wsl -d Ubuntu -u root -- bash scripts/actor-dev.sh
# 2. Bridge (ADS-B poller, conflict alert, HTTP API, RADAR on Relay)
bun run bridge
# 3. Sector controller agents (need OPENAI_API_KEY in .env)
bun run agent NORTH
bun run agent SOUTH
bun run agent MONITOR
# Check everything end to end without a UI
bun scripts/backend-check.ts
```

Without the agent processes, start the bridge with `CLEARANCE_MODE=direct` so the probe decides instead of waiting 8 s for a sector agent.

---

## HTTP endpoints (bridge)

### `GET /config`
```json
{ "dataSource": "live", "radiusNm": 35, "relayObserverUrl": "https://agentrelay.com/observer", "relay": true }
```
`dataSource` drives the `LIVE` / `REPLAY` badge.

### `GET /airports/:code`
Validate as the user types. Accepts `KSFO`, `ksfo`, `SFO` (3-letter tries `K`+code, then IATA, then FAA local code).

- **200**: the `Airport`
```json
{ "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "state": "CA",
  "lat": 37.61981, "lon": -122.37482, "elevationFt": 13, "radiusNm": 35, "declinationDeg": 12.8 }
```
- **404**: `{ "error": "No US airport matches \"KSX\".", "suggestions": [{ "icao": "KSFO", "name": "...", "city": "..." }] }`

### `POST /session` `{ "code": "KSFO" }`
Validates, calls `Airspace.configure`, restarts the poller, posts `SESSION ...` to `#radar`.
- **200** `{ "airport": Airport }`
- **404** `{ "error", "suggestions" }` (unknown code)
- **409** `{ "airport": Airport, "error": "No recording for KSFO. ..." }` (replay mode with no recording)

The Airspace websocket also delivers the new `airport` (and resets `traffic`, `conflicts`, …), so the UI can just react to state.

### `POST /source` `{ "dataSource": "live" | "replay" }`  *(extra, for demo step 6)*
Switches live ↔ replay at runtime and restarts the current airport's session. Response as `/session`.

### `GET /grant?actor=Airspace&id=main` / `GET /grant?actor=Aircraft&id=<hex>`
```json
{ "websocketUrl": "ws://127.0.0.1:7100/v1/socket?key=...", "connectByMs": 1793472767806 }
```
Open `new WebSocket(websocketUrl)` before `connectByMs` (about 60 s). On close/error, fetch a **new** grant and reconnect. An `Aircraft` actor exists once a clearance was issued to that hex; before that its state is empty defaults (`status: "none"`, `clearance: null`).

### `POST /clearance`
Runs the clearance workflow (CLAUDE.md 11a): **parse → resolve → probe → sectorReview → result**.

Request:
```jsonc
{
  "text": "Southwest twenty-one forty, descend and maintain four thousand",  // transcript or typed text
  "override": false,              // optional: CIC override (skips sector review, logged to #cic + alerts)
  "confirmed": false,             // optional: resend with true after the CIC answers a "needsConfirm" question
  "selectedHex": "a1b2c3",        // optional: currently selected aircraft (parser prefers it on ambiguity)
  "clearance": {                  // optional: structured clearance, skips the LLM parse
    "callsign": "SWA2140", "kind": "altitude", "value": 4000          // (use for "Issue alternative")
  }
}
```

Response (`ClearanceResult`):
```jsonc
// Issued
{ "issued": true, "transcript": "...", "phraseology": "Southwest twenty-one forty, descend and maintain four thousand.",
  "parsed": { "callsign": "SWA2140", "kind": "altitude", "value": 4000 },
  "hex": "a1b2c3", "sector": "SOUTH", "probe": ProbeResult,
  "steps": [ { "id": "parse", "status": "ok", "detail": "SWA2140 altitude 4000", "ms": 820 }, ... ] }

// Unable (sector controller reply or probe), with a one-click alternative
{ "issued": false, "transcript": "...",
  "reason": "Unable, Flexjet five zero four to one thousand eight hundred, traffic ..., 2.3 miles, 300 feet, in 10 seconds. Suggest two thousand six hundred.",
  "alternative": { "callsign": "LXJ504", "kind": "altitude", "value": 2600,
                   "text": "Flexjet five zero four, maintain two thousand six hundred." },
  "probe": { "ok": false, "reasons": ["Traffic BYF21, 2.3 NM, 300 ft, in 10 s."], "conflicts": [ ... ] },
  "parsed": { ... }, "hex": "...", "sector": "NORTH", "steps": [ ... ] }

// Couldn't parse / unknown / ambiguous callsign  (HTTP 422, same JSON body; all other outcomes are HTTP 200)
{ "issued": false, "transcript": "...", "reason": "Say again, which Southwest, twenty-one forty or twenty-one fifty-five?",
  "sayAgain": true, "suggestions": ["SWA2140", "SWA2155"], "options": ["Southwest twenty-one forty", "Southwest twenty-one fifty-five"], "steps": [ ... ] }

// Sector asks the CIC to confirm (recent contradicting clearance, or it would break an agreement)
{ "issued": false, "needsConfirm": true, "question": "Confirm, United one twenty-three was cleared to four thousand thirty seconds ago?",
  "review": { "decision": "confirm", "by": "NORTH", "reason": "Reverses the descent issued 30 s ago.", "question": "..." }, ... }
```

**AI review (`review`, every non-override response after the probe):** the owning sector controller agent chooses, from math-validated options only, and explains why:
```jsonc
"review": {
  "decision": "issue" | "unable" | "confirm" | "coordinate",
  "by": "NORTH" | "SOUTH" | "FALLBACK",       // FALLBACK = the agent timed out/was invalid; rules decided (also posted to #cic)
  "reason": "Keeps the departure climbing instead of stopping it at five thousand.",   // show as "Why this option"
  "question": "...",                          // for confirm
  "pointOut": { "to": "SOUTH", "result": "approved" | "unable" | "no_response", "reason": "..." }   // for coordinate
}
```
- `decision: "coordinate"`: the clearance would take the aircraft into the other sector within 120 s, so the sector sent a **point out** over Relay and waited for "point out approved" before issuing (the step list shows `coordinate`).
- `alternative` on an Unable is the **candidate the agent chose** (`alternative.candidateId`); all safe candidates are in `probe.alternatives` (`Candidate[]`: `id, kind, value, turn?, phraseology, deviation, tags`).
- **Unable card:** show `reason` (the spoken Unable), then **"Why this option": `review.reason`**, `probe.reasons`; "Issue alternative" = `POST /clearance { text: alternative.text, clearance: alternative }`; "CIC override" = resend the original request with `override: true`.
- **Confirm card** for `needsConfirm`: show `question` with **Confirm** (resend the same request with `confirmed: true`; any agreement it breaks is cancelled by the CIC and posted to `#coord`) and **Cancel**.
- `steps[].id` ∈ `parse | resolve | probe | context | sectorReview | coordinate | issue` (render unknown ids generically), `status` ∈ `ok | fail | skipped`. `sectorReview` with `fail` + "Fallback used" means the rules decided.
- `sector` picks the voice for speaking an Unable reply.
- Every issued clearance also appears in the feed in `#cic` (from the sector agent, or from `CIC` in direct mode and for overrides).

**Streaming step progress (optional):** send `Accept: text/event-stream` (or `?stream=1`). Server-Sent Events:
```
event: step
data: {"id":"parse","status":"ok","detail":"SWA2140 altitude 4000","ms":812}

event: step
data: {"id":"probe","status":"ok","detail":"No conflicts. Valid.","ms":3}

event: result
data: { ...same ClearanceResult as above... }
```
(`EventSource` only does GET, so read the POST response body with `fetch` + a stream reader and split on blank lines.)

### `POST /transcribe` (body = raw audio from `MediaRecorder`, e.g. `audio/webm`)
Optional query `?selected=<hex>` (that aircraft's callsign goes first in the Deepgram keyterms).
- **200** `{ "transcript": "united one twenty three climb and maintain one zero thousand", "confidence": 0.97 }`
- **503** `{ "error": "Deepgram not configured." }` / **502** on Deepgram failure → fall back to the Web Speech API, then `POST /clearance` with the text.

### `POST /speak` `{ "text": "...", "voice": "NORTH" | "SOUTH" | "MONITOR" }`
Returns `audio/mpeg` (Deepgram Aura-2; NORTH and SOUTH have different voices; cached by text). On error (`503`/`502` JSON) fall back to `speechSynthesis`. Queue clips so they never overlap.

### `POST /cic` `{ "text": "SOUTH, stop accepting handoffs for two minutes" }`
Posts to `#cic` as the CIC. Agents acknowledge in `#cic`. → `{ "ok": true }`

### `GET /health`
`{ ok, airport, session, dataSource, lastPollAt, lastError, aircraftCount, relay }` (debugging).

---

## Websocket protocol (Terse actors)

Every socket sends, in order:
1. `{ "type": "state", "state": { ...all emitted fields... }, "version": 3 }` (on connect)
2. `{ "type": "state_update", "changes": { "<field>": <full new value> }, "removed": [], "version": 4 }` (after every change)

Apply `state`, then shallow-merge each `state_update.changes` (each changed top-level field arrives with its **full new value**) and delete keys in `removed`. Ignore other message types (the Aircraft actor also broadcasts `{ "type": "status", "hex", "status", "reason" }` when its status changes).

### `Airspace` (id `"main"`) emitted state
```ts
{
  airport: Airport | null;                 // null => show the start screen
  session: number;                         // increments on every airport change
  traffic: TrafficEntry[];                 // every aircraft in range, replaced every ~5 s
  trackControl: Record<hex, "NORTH" | "SOUTH">;
  handoffs: Handoff[];                     // state: pending | accepted | unable | overdue  (pending => blink)
  conflicts: ConflictAlert[];              // open (active | coordinating | escalated) + last 10 resolved
  feed: FeedItem[];                        // last 100 Relay messages, oldest first
  alerts: AlertItem[];                     // last 20: NONCONF | CA | HANDOFF_OVERDUE | ESCALATED | OVERRIDE | INFO
  agreements: Agreement[];                 // coordination memory: active + last 10 expired/cancelled (see below)
  directives: Directive[];                 // CIC directives to sectors: active + last 10 expired
  clearanceLog: ClearanceLogEntry[];       // last 20 issued clearances { ts, hex, callsign, kind, value, turn?, phraseology, issuedBy }
}
```
`TrafficEntry` = `{ hex, callsign, typeCode, lat, lon, altFt, vertRateFpm, gsKt, trackTrueDeg, status, sector, ca, ts, seenSec }`.

- **Data block:** line 1 `callsign`; line 2 = altitude in hundreds (3 digits) + `↑` if `vertRateFpm > 500` / `↓` if `< -500` + ground speed in tens: `078↑ 28`. Helper: `dataBlock(altFt, vertRateFpm, gsKt)` in `shared/format.ts`.
- **Status colors:** `none` white, `pending` amber, `conforming` green, `non_conforming` red, `coasting` gray + `CST`.
- **Agreements** (`Agreement` in shared/types.ts): `{ id, hex, callsign, constraint: { kind, op: "maintain"|"at_or_below"|"at_or_above", value }, between, source: "APREQ"|"handoff"|"CIC", text, createdAt, expiresAt, state: "active"|"expired"|"cancelled" }`. Created when sectors agree an APREQ plan or accept a handoff with a condition; a later clearance that breaks one comes back Unable or Confirm. Left-panel "Agreements" list: `callsign`, `text`, who (`source`/`between`), time left (`expiresAt - now`) for `state === "active"`.
- **Directives** (`Directive`): `{ id, target: "NORTH"|"SOUTH"|"ALL", text, rule?: { type: "no_handoffs"|"altitude_cap"|"altitude_floor"|"other", value? }, createdAt, expiresAt, state }`. Stored when the CIC addresses a sector in `#cic` ("SOUTH, stop accepting handoffs for two minutes"). Left-panel "Directives" list for `state === "active"`.
- **Estimated phase** (departure/arrival/overflight) appears in the review facts and agent reasons; label it "estimated phase" in the UI (heuristic, not a flight plan).
- **Coasting tracks:** an aircraft with an active clearance (status not `none`) that drops out of the ADS-B feed stays in `traffic` with its **last known** position/altitude/`ts`/`seenSec` and `status: "coasting"`, keeping its `sector`/`trackControl`, until 60 s after its last `ts`; then it is removed. Its age is `Date.now() - ts` (the entry is not dead-reckoned). If it reappears, the fresh entry replaces it and its status returns to the conformance result on the next poll. Aircraft without a clearance still disappear as soon as they leave the feed.
- **Sector tint:** `sector` (= `trackControl[hex]`).
- **CA:** `ca: true` → red `CA` on the data block; draw a line between `hexA`/`hexB` of each open conflict.
- **Sector boundary:** the east-west line (latitude `airport.lat`); NORTH above, SOUTH below. Range rings every 10 NM to `airport.radiusNm`.

`ConflictAlert` = `{ id, a, b, hexA, hexB, sectors: [s1, s2], predictedLatNm, predictedVertFt, inSec, state, resolution?, raisedAt, dueAt }`.
`Handoff` = `{ hex, callsign, from, to, startedAt, dueAt, state, reason? }`.

### `Aircraft` (id = ICAO hex, lowercase) emitted state — detail card
```ts
{ callsign: string; clearance: Clearance | null; track: Position[] /* last 24, oldest first */; status: Status; statusReason: string }
```
`statusReason` is plain English, e.g. `Cleared to 4,000. Now 8,600 and climbing 2,900 fpm.` `clearance.phraseology` is the spoken clearance; `clearance.value` is the cleared altitude (dashed line on the altitude chart).

---

## Relay feed conventions (`Airspace.feed`)

`FeedItem` = `{ ts, from, to, text }`.
- `from`: `RADAR` (machine events), `NORTH`, `SOUTH`, `MONITOR` (agents), `CIC` (human / bridge on behalf of the CIC), `SYSTEM`.
- `to`: a channel (`#radar`, `#coord`, `#alerts`, `#cic`) or, for DMs, the recipient name (`NORTH`, `SOUTH`, `MONITOR`, `CIC`). "DM" filter = `!to.startsWith("#")`.
- RADAR event formats: `BOUNDARY UAL123 NORTH->SOUTH in 2.5 NM, 078 climbing` (one retry, suffixed ` (retry)` with `data.attempt: 2`, 30 s after a handoff ends `overdue` or `unable`), `CA UAL123/DAL456 predicted 1.8 NM / 400 FT in 70 s (NORTH/SOUTH)`, `NONCONF SWA2140 cleared 040, now 078 climbing 1,800 fpm (owner SOUTH)`, `SESSION KSFO (San Francisco International Airport) started, radius 35 NM`.
- **Speak (TTS)** new items where `to === "#cic" || to === "CIC"` and `from` is `NORTH`, `SOUTH` or `MONITOR` (Unable replies, APREQ outcomes, escalations, acknowledgements), with `voice = from`. Don't speak the backlog from the initial `state` message.
