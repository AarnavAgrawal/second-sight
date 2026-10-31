# API.md: Second Sight backend ↔ frontend contract

This file is the agreement between the backend (bridge, actors, agents) and the frontend (`web/`). Build against it, not against each other's code.

- **Backend owner:** Aarnav. **Frontend owner:** teammate.
- **Changing anything in this file requires both of us to agree**, then update this file in the same commit.
- If the real backend behaves differently from this file, the backend is wrong unless we agree to change the file.

---

## 1. Basics

- **Bridge base URL:** `http://localhost:8787` (frontend reads it from `VITE_API_URL`).
- **Frontend dev server:** `http://localhost:5173` (Vite default). The bridge allows CORS from it.
- **Format:** JSON in and out, except audio endpoints (noted below).
- **Times:** Unix epoch milliseconds (`number`).
- **Altitudes:** feet, pressure altitude (`number`), or `null` if unknown.
- **Distances:** nautical miles (NM). **Speeds:** knots. **Vertical rate:** feet per minute (fpm), positive = climbing.
- **Errors:** any non-2xx response has the body `{ "error": string, "details"?: unknown }`.

The UI gets data two ways:
1. **HTTP endpoints** (section 3) when the UI asks the backend to do something.
2. **Live state over WebSocket** (section 4) pushed from the Terse actors. The scope never polls for traffic.

---

## 2. Types

Use these exact names. The backend exports them from `shared/types.ts`; the frontend can import that file directly.

```ts
type Sector = "NORTH" | "SOUTH";

type Status = "none" | "pending" | "conforming" | "non_conforming" | "coasting";

type Channel = "#radar" | "#coord" | "#alerts" | "#cic";

interface Airport {
  icao: string;          // "KSFO"
  name: string;          // "San Francisco International Airport"
  city: string;          // "San Francisco"
  state: string;         // "CA"
  lat: number;
  lon: number;
  elevationFt: number;
  radiusNm: number;      // 35
}

interface TrafficItem {
  hex: string;           // ICAO 24-bit address, e.g. "a1b2c3"; stable id for keys
  callsign: string;      // "UAL123" (trimmed); falls back to registration or hex
  lat: number;
  lon: number;
  altFt: number | null;
  vertRateFpm: number;
  gsKt: number;
  trackTrueDeg: number;
  status: Status;
  statusReason?: string; // plain English, present when status is pending / conforming / non_conforming
  sector: Sector;        // sector with track control
  ca: boolean;           // true if in an active conflict alert
}

interface Clearance {
  kind: "altitude" | "heading";
  value: number;         // feet for altitude (e.g. 8000, 24000), degrees magnetic for heading (1..360)
  turn?: "left" | "right";
  issuedAt: number;
  graceUntil: number;
  deadlineAt: number;
  issuedBy: string;      // "CIC", "NORTH", "SOUTH"
  phraseology: string;   // "United one twenty-three, climb and maintain eight thousand."
}

interface Handoff {
  hex: string;
  callsign: string;
  from: Sector;
  to: Sector;
  startedAt: number;
  dueAt: number;
  state: "pending" | "accepted" | "unable" | "overdue";
}

interface ConflictAlert {
  id: string;
  a: string;  aHex: string;   // callsign and hex of aircraft A
  b: string;  bHex: string;   // callsign and hex of aircraft B
  sectors: [Sector, Sector];
  predictedLatNm: number;     // minimum predicted lateral distance
  predictedVertFt: number;    // vertical distance at that point
  inSec: number;              // seconds until predicted loss of separation
  state: "active" | "coordinating" | "resolved" | "escalated";
  resolution?: string;        // agreed plan in plain English
  dueAt: number;
}

interface FeedItem {
  id: string;
  ts: number;
  from: string;               // "RADAR", "NORTH", "SOUTH", "MONITOR", "CIC"
  channel?: Channel;          // set for channel posts
  to?: string;                // set for DMs, e.g. "SOUTH"
  text: string;
}

interface Alert {
  id: string;
  ts: number;
  level: "info" | "warning" | "critical";
  text: string;
  callsign?: string;
  hex?: string;
}

interface ProbeConflict {
  with: string;               // callsign
  minLatNm: number;
  minVertFt: number;
  inSec: number;
}

interface ProbeResult {
  ok: boolean;
  reasons: string[];          // plain English, empty when ok
  conflicts: ProbeConflict[];
  alternative?: { kind: "altitude" | "heading"; value: number; turn?: "left" | "right"; phraseology: string };
}

type WorkflowStepName = "parse" | "resolve" | "probe" | "sectorReview" | "result";

interface WorkflowStep {
  name: WorkflowStepName;
  ok: boolean;
  ms: number;                 // how long the step took
  summary: string;            // one line for the UI, e.g. "SOUTH has track control"
}

interface Position {          // for the detail card altitude chart
  ts: number;
  lat: number;
  lon: number;
  altFt: number | null;
  vertRateFpm: number;
  gsKt: number;
  trackTrueDeg: number;
}
```

---

## 3. HTTP endpoints

### `GET /health`
Called once on load and after `POST /session`.

```json
{ "ok": true, "dataSource": "live", "airport": "KSFO" }
```
`dataSource` is `"live"` or `"replay"` (drives the LIVE / REPLAY badge). `airport` is `null` before one is chosen.

### `GET /airports/:code`
Validate as the user types. Accepts 4-letter codes (and 3-letter as a convenience).

Match:
```json
{ "airport": { "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "state": "CA", "lat": 37.6188, "lon": -122.3754, "elevationFt": 13, "radiusNm": 35 } }
```
No match (status 404):
```json
{ "error": "No US airport matches KSFX", "suggestions": [ { "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "state": "CA" } ] }
```

### `POST /session`
Pick or switch the airport.

Request:
```json
{ "code": "KSFO" }
```
Response:
```json
{ "airport": { "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "state": "CA", "lat": 37.6188, "lon": -122.3754, "elevationFt": 13, "radiusNm": 35 } }
```
After this, the `Airspace` state (section 4) changes to the new airport. The UI doesn't need to reload anything else.

### `POST /clearance`
Send a typed or transcribed clearance. Runs the full clearance workflow. Takes about 2 to 9 seconds (the sector controller has up to 8 s to answer). Show a progress state while waiting.

Request:
```json
{ "text": "Southwest twenty-one forty, descend and maintain four thousand", "override": false }
```
`override: true` is the CIC override button on the Unable card. Send the **alternative's phraseology** as `text` for the "Issue alternative" button.

Issued:
```json
{
  "issued": true,
  "callsign": "SWA2140",
  "hex": "a4f1c2",
  "phraseology": "Southwest twenty-one forty, descend and maintain four thousand.",
  "probe": { "ok": true, "reasons": [], "conflicts": [] },
  "steps": [
    { "name": "parse", "ok": true, "ms": 640, "summary": "SWA2140 descend to 4,000" },
    { "name": "resolve", "ok": true, "ms": 2, "summary": "SOUTH has track control" },
    { "name": "probe", "ok": true, "ms": 5, "summary": "No conflicts" },
    { "name": "sectorReview", "ok": true, "ms": 2100, "summary": "SOUTH issued" },
    { "name": "result", "ok": true, "ms": 1, "summary": "Issued" }
  ]
}
```

Unable:
```json
{
  "issued": false,
  "callsign": "UAL123",
  "hex": "a1b2c3",
  "reason": "Unable, United one twenty-three to eight thousand, traffic Delta four fifty-six, eight thousand, two miles ahead.",
  "alternative": { "kind": "altitude", "value": 7000, "phraseology": "United one twenty-three, climb and maintain seven thousand." },
  "probe": {
    "ok": false,
    "reasons": ["Conflict with DAL456 in 70 s"],
    "conflicts": [ { "with": "DAL456", "minLatNm": 1.8, "minVertFt": 0, "inSec": 70 } ]
  },
  "steps": [
    { "name": "parse", "ok": true, "ms": 610, "summary": "UAL123 climb to 8,000" },
    { "name": "resolve", "ok": true, "ms": 2, "summary": "NORTH has track control" },
    { "name": "probe", "ok": false, "ms": 6, "summary": "Conflict with DAL456" },
    { "name": "sectorReview", "ok": false, "ms": 1900, "summary": "NORTH: Unable" },
    { "name": "result", "ok": false, "ms": 1, "summary": "Not issued" }
  ]
}
```
`alternative` may be missing if no safe alternative exists.

Parse failure (status 422):
```json
{ "error": "Say again", "details": { "transcript": "southwest twenty one", "closestCallsigns": ["SWA2140", "SWA1021"] } }
```

No sector response in 8 s: `issued: false` with `reason: "No response from SOUTH"` and the probe result. The UI shows the CIC override button.

### `POST /transcribe`
Push-to-talk audio to text.

- Request body: the raw recording from `MediaRecorder` (e.g. `audio/webm`), with the matching `Content-Type` header.
- Response:
```json
{ "transcript": "southwest twenty one forty descend and maintain four thousand", "source": "deepgram" }
```
- If Deepgram isn't available, the bridge returns status 503. The UI then falls back to the browser Web Speech API on the next press and sends its text straight to `POST /clearance`.
- The UI flow is always: `/transcribe` → show transcript → `/clearance` with the transcript as `text`.

### `POST /speak`
Text to speech for controller replies to the CIC.

Request:
```json
{ "text": "Unable, United one twenty-three to eight thousand, traffic Delta four fifty-six.", "voice": "NORTH" }
```
`voice` is `"NORTH"`, `"SOUTH"`, or `"MONITOR"` (each maps to a different voice if available).

Response: audio bytes (`Content-Type: audio/mpeg`). On failure, status 503; the UI falls back to `speechSynthesis`.

**What the UI should speak:** new `FeedItem`s where `channel === "#cic"` or `to === "CIC"`, from NORTH, SOUTH, or MONITOR. Queue clips so they never overlap. Respect the mute toggle.

### `POST /cic`
CIC posts a message to all agents.

Request:
```json
{ "text": "SOUTH, stop accepting handoffs for two minutes." }
```
Response:
```json
{ "ok": true }
```
The message also appears in the `Airspace` feed.

### `GET /grant?actor=Airspace&id=main`
### `GET /grant?actor=Aircraft&id=<hex>`
Returns a one-time WebSocket link to an actor.

```json
{ "websocketUrl": "ws://127.0.0.1:7100/...", "connectByMs": 1730392800000 }
```
Open the socket before `connectByMs`. **A reconnect needs a new grant**, so on close, call `/grant` again and reopen. Back off 1 s, 2 s, 4 s, max 8 s.

---

## 4. Live state over WebSocket

### Messages
The actor sends three kinds of messages. **Wrap parsing in one function** (`parseActorMessage`) so if the real envelope differs slightly, only that function changes. The backend will confirm the exact envelope in Phase 1.

```ts
type ActorMessage =
  | { type: "state"; state: Record<string, unknown> }          // full state, on connect
  | { type: "state_update"; changes: Record<string, unknown> } // only fields that changed
  | { type: "status"; hex: string; status: Status; reason: string }; // Aircraft actor, custom
```
On `state`, replace local state. On `state_update`, merge `changes` field by field (each changed field arrives whole, e.g. the full `traffic` array).

### `Airspace` actor (id `main`): open on load, keep open

```ts
interface AirspaceState {
  airport: Airport | null;                // null → show the start screen
  traffic: TrafficItem[];                 // every aircraft in range, updated every ~5 s
  trackControl: Record<string, Sector>;   // hex → sector (also mirrored in traffic[].sector)
  handoffs: Handoff[];
  conflicts: ConflictAlert[];             // active plus the last 10 resolved
  feed: FeedItem[];                       // last 100 Relay messages, oldest first
  alerts: Alert[];                        // last 20
}
```

Example:
```json
{
  "airport": { "icao": "KSFO", "name": "San Francisco International Airport", "city": "San Francisco", "state": "CA", "lat": 37.6188, "lon": -122.3754, "elevationFt": 13, "radiusNm": 35 },
  "traffic": [
    { "hex": "a1b2c3", "callsign": "UAL123", "lat": 37.71, "lon": -122.40, "altFt": 7800, "vertRateFpm": 1800, "gsKt": 280, "trackTrueDeg": 345, "status": "conforming", "statusReason": "Climbing toward 10,000 at 1,800 fpm.", "sector": "NORTH", "ca": false },
    { "hex": "a4f1c2", "callsign": "SWA2140", "lat": 37.50, "lon": -122.25, "altFt": 7800, "vertRateFpm": 1800, "gsKt": 260, "trackTrueDeg": 150, "status": "non_conforming", "statusReason": "Cleared to 4,000. Now 7,800 and climbing 1,800 fpm.", "sector": "SOUTH", "ca": false },
    { "hex": "c3d4e5", "callsign": "DAL456", "lat": 37.64, "lon": -122.31, "altFt": 6000, "vertRateFpm": 0, "gsKt": 230, "trackTrueDeg": 10, "status": "none", "sector": "NORTH", "ca": true }
  ],
  "trackControl": { "a1b2c3": "NORTH", "a4f1c2": "SOUTH", "c3d4e5": "NORTH" },
  "handoffs": [
    { "hex": "c3d4e5", "callsign": "DAL456", "from": "SOUTH", "to": "NORTH", "startedAt": 1730392700000, "dueAt": 1730392730000, "state": "accepted" }
  ],
  "conflicts": [
    { "id": "ca-1", "a": "DAL456", "aHex": "c3d4e5", "b": "JBU811", "bHex": "e5f6a7", "sectors": ["NORTH", "SOUTH"], "predictedLatNm": 1.8, "predictedVertFt": 400, "inSec": 70, "state": "coordinating", "dueAt": 1730392760000 }
  ],
  "feed": [
    { "id": "f1", "ts": 1730392700000, "from": "RADAR", "channel": "#radar", "text": "BOUNDARY DAL456 SOUTH->NORTH in 2.5 NM, 060 level" },
    { "id": "f2", "ts": 1730392702000, "from": "SOUTH", "to": "NORTH", "text": "Handoff, Delta four fifty-six, six thousand, three miles south of the line." },
    { "id": "f3", "ts": 1730392704000, "from": "NORTH", "to": "SOUTH", "text": "Delta four fifty-six, radar contact." }
  ],
  "alerts": [
    { "id": "al1", "ts": 1730392710000, "level": "warning", "text": "SWA2140 non-conforming: cleared to 4,000, climbing through 7,800.", "callsign": "SWA2140", "hex": "a4f1c2" }
  ]
}
```

### `Aircraft` actor (id = hex): open when an aircraft is selected, close when deselected

```ts
interface AircraftState {
  callsign: string;
  clearance: Clearance | null;
  track: Position[];      // last 24 positions, oldest first (detail card altitude chart)
  status: Status;
  statusReason: string;
}
```
Only aircraft that have received a clearance have an `Aircraft` actor. For any other aircraft, the detail card shows data from `traffic` only and doesn't open a socket.

---

## 5. UI display rules (so the scope looks like a real one)

- **Data block,** two lines next to each target with a short leader line:
  - Line 1: callsign (`UAL123`).
  - Line 2: altitude in hundreds of feet, 3 digits (`7800` → `078`, `24000` → `240`, `null` → `XXX`), then `↑` if `vertRateFpm >= 500`, `↓` if `<= -500`, nothing otherwise, then a space and ground speed in tens of knots (`280` → `28`). Example: `078↑ 28`.
  - If `status === "coasting"`, add `CST`. If `ca`, add `CA` in red.
- **Status colors:** `none` white, `pending` amber, `conforming` green, `non_conforming` red, `coasting` gray.
- **Sector tint:** a subtle tint or marker for NORTH vs SOUTH on each target, separate from status color.
- **Pending handoff:** the data block blinks while a `Handoff` for that hex has `state === "pending"`.
- **Conflict alert:** draw a red line between `aHex` and `bHex` for conflicts with state `active`, `coordinating`, or `escalated`.
- **Scope geometry:** range rings every 10 NM out to `radiusNm`, and the sector boundary as an east-west line through the airport's latitude. NORTH above, SOUTH below.
- **Target symbol:** small marker rotated to `trackTrueDeg`.
- **Feed colors:** one color per sender (`RADAR`, `NORTH`, `SOUTH`, `MONITOR`, `CIC`). Filters by `channel`. DMs show as `NORTH → SOUTH`.
- **Climbing / Descending filter:** client-side, `vertRateFpm >= 500` or `<= -500`.
- **Quiet airspace hint:** if `traffic.length < 5` 20 s after a session starts, show "Quiet airspace. Try a busier airport."
- **Terminology:** use "clearance", never "instruction" or "command". See CLAUDE.md section 2 for the full glossary.

---

## 6. Mock mode (frontend builds against this first)

Until the real backend is ready, the frontend runs with `VITE_USE_MOCK=true`:

- `web/src/mock/api.ts`: implements every endpoint in section 3 with the example responses. `/clearance` alternates between the Issued and Unable examples. `/transcribe` returns a fixed transcript after 500 ms. `/speak` fails with 503 so the `speechSynthesis` fallback gets tested.
- `web/src/mock/airspace.ts`: emits `state` on connect, then `state_update` with `traffic` every 5 s. Fake 6 to 8 aircraft moving on simple paths around the airport (some climbing, some descending), one pending handoff that flips to accepted after 10 s, one conflict that goes `active` → `coordinating` → `resolved`, and a new feed item every few seconds.
- The rest of the UI must not know whether it's talking to the mock or the real backend. Switch only in one place.

---

## 7. Integration checklist (12:50 sync)

1. Backend running: `terse actor dev`, `bun run bridge`. Frontend: set `VITE_USE_MOCK=false`.
2. `GET /health` returns `ok`.
3. Start screen → type `KSFO` → `POST /session` → scope shows real traffic from the `Airspace` socket.
4. Data blocks show correct altitude and arrows against a known aircraft.
5. Type a clearance → `POST /clearance` → status color changes on the scope.
6. Click the aircraft → its `Aircraft` socket opens → detail card shows the clearance.
7. Write down anything that didn't match this file and fix it (or agree to change the file).
