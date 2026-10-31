# CLAUDE.md: Second Sight (AI air traffic control on Durable Actors + Agent Relay)

You are building **Second Sight** with me, solo, at the Haunted Hacks hackathon (Oct 31, 2026, SF). Hacking runs **11:00am to 4:00pm** (lunch around 1:00). Submission is due at 4:00. Every line of code must be written today, at the event. This file is the plan.

Read this whole file before writing any code. Then follow the phases in order. Use the aviation terms in section 2 exactly as written, in code names, UI text, and agent messages.

---

## 1. What we're building

A live AI air traffic control system for the airspace around **any US airport**, built on real aircraft data.

- At startup, the app asks me to pick an airport. I type its 4-letter ICAO code (`KSFO`, `KJFK`, `KORD`, `PHNL`), and the scope centers on it. I can switch airports later from the header.
- Real aircraft positions stream in from a free ADS-B feed and show on a dark radar scope with STARS-style data blocks.
- The airspace is split into two sectors, **NORTH** and **SOUTH**. Each sector has an AI sector controller agent.
- I'm the **Controller-in-Charge (CIC)**. I issue clearances by **voice** (push-to-talk) or by typing, using standard phraseology: "United one twenty-three, climb and maintain eight thousand."
- Before a clearance is issued, the owning sector controller agent **probes** it for conflicts and bad values. If it's unsafe, the agent responds "Unable" with the reason and a safer alternative.
- Once issued, the system runs **conformance monitoring**: it watches whether the aircraft does what it was cleared to do and flags non-conformance in plain English.
- The system runs a continuous **conflict alert**: it predicts loss of separation between any two aircraft. If the two aircraft are in different sectors, the two sector controllers coordinate a resolution over Agent Relay with an **APREQ** (approval request).
- When an aircraft nears the sector boundary, the owning controller performs a **handoff** to the other sector, which accepts with "radar contact."

The real aircraft never hear our clearances. The demo shows conformance against real aircraft by issuing clearances that match or contradict what they're already doing (see section 15). The scope says so clearly: this is a simulation layered on live traffic.

### Why each tool is here (this is the pitch, keep it true)

- **Terse Durable Actors hold all state.** Each aircraft with an active clearance is an actor with its own memory and its own timer for conformance checks. One `Airspace` actor owns track control (which sector controls which aircraft), handoffs, and conflict alerts. Actors process one call at a time, so an aircraft can never be under two sectors' control or none during a handoff. Real ATC automation enforces exactly this.
- **Agent Relay carries all coordination.** Each sector controller agent runs as its own process with its own Relay identity. The only way they talk is through Relay channels and DMs, the way real controllers in adjacent sectors coordinate over an interphone line.
- **Mastra runs the agents and the clearance pipeline.** NORTH, SOUTH, and MONITOR are Mastra agents with typed Mastra tools, running Claude models. The path from a spoken clearance to an issued one (parse, resolve, probe, sector review, issue) is a Mastra workflow, so every step is explicit and visible.
- **Design rule: rules compute facts, LLMs talk.** Geometry, separation math, conformance, probes, and track control are plain deterministic code. Claude only parses speech into clearances and decides how to phrase and coordinate. This keeps the demo reliable.

---

## 2a. Why this matters (pitch context, also use for README and submission text)

Keep claims modest. Real US radar systems already have conflict alerts. Frame Second Sight as **assisting** overloaded controllers (conformance monitoring, always-on conflict prediction, automatic coordination between sectors), never as something that alone would have prevented these accidents.

**Überlingen, Germany, July 1, 2002 (71 killed, 52 of them children).** Bashkirian Airlines 2937 and DHL 611 collided at night.
- The Zurich controller was alone on position, working the entire airspace from one workstation while a colleague rested.
- The visual Short-Term Conflict Alert was off for maintenance.
- The telephone system was also down for maintenance and the backup was misconfigured, so an adjacent center whose own conflict alert fired could not reach Zurich to warn him.
- Mapping to Second Sight: always-on conflict alert, AI sector controllers covering for an overloaded human, and a durable coordination channel (Relay) where a warning waits in the inbox instead of failing like a dead phone line.

**Washington DC (DCA), January 29, 2025 (67 killed).** PSA Airlines flight 5342 (American Eagle CRJ700) collided with a U.S. Army Black Hawk (PAT25) on approach to Runway 33.
- NTSB probable cause: the FAA placed helicopter routes too close to the approach path and didn't mitigate the risk. Black Hawk altimeter errors and high controller workload were also cited.
- The helicopter route had a 200 ft altitude limit.
- From October 2021 to December 2024, there were 15,214 events where airliners and helicopters near DCA were within 1 NM laterally and 400 ft vertically, and 85 within 1,500 ft and 200 ft.
- From 2011 to 2024, at least one TCAS resolution advisory per month was triggered by a helicopter near DCA. In over half, the helicopter may have been above its route altitude restriction.
- Mapping to Second Sight: conformance monitoring flags an aircraft above its altitude restriction, and continuous conflict alerting surfaces a pattern that happened thousands of times.

**Controller staffing (2026).**
- About 10,968 certified professional controllers in FY2026, against an FAA target of 12,563. The target was cut from 14,633 in the 2024 plan, and the controllers' union opposes the cut.
- Controllers logged about 2.2 million hours of overtime in 2024 (about $200 million).
- The FAA's own plan relies on automation to help close the gap.

Sources (link these in the README):
- NTSB final report coverage: https://www.globalair.com/articles/ntsb-releases-final-report-on-potomac-midair-collision/11956
- DCA preliminary findings: https://theaviationist.com/2025/03/11/potomac-river-collision-preliminary-report/
- Überlingen: https://www.faa.gov/lessons_learned/transport_airplane/accidents/RA-85816
- Staffing: https://backend.ainonline.com/aviation-news/air-transport/2026-05-18/faa-cuts-2000-certified-controller-goal-2026-plan

Do not use crash imagery or Halloween jokes near this material in the UI or README.

---

## 2. Aviation terminology (use these exact terms)

| Term | Meaning in this project |
|---|---|
| **Clearance** | An ATC assignment to one aircraft: an altitude or a heading. Never call it an "instruction" or "command" in code or UI. |
| **Callsign** | Aircraft identification, e.g. ICAO `UAL123`, spoken with its telephony designator: "United one twenty-three." |
| **Telephony designator** | The spoken airline name: `UAL` = "United", `SWA` = "Southwest", `JBU` = "JetBlue". |
| **Data block** | The label next to each aircraft target: callsign on line 1, altitude in hundreds of feet + vertical trend arrow (↑/↓) + ground speed in tens of knots on line 2. Example: `UAL123` / `078↑ 28`. |
| **Track** | An aircraft's position history on the scope. ADS-B `track` is its true ground track in degrees. |
| **Heading** | Where the nose points, **magnetic**, assigned as three digits ("heading two seven zero"). Differs from ground track by wind and magnetic variation. |
| **Flight level (FL)** | Altitudes at or above 18,000 ft in the US are flight levels: FL230 = "flight level two three zero". Below 18,000 ft, use feet: "eight thousand", "one zero thousand", "six thousand five hundred". |
| **Conformance monitoring** | Checking whether an aircraft is doing what it was cleared to do. Status values: `none`, `pending`, `conforming`, `non_conforming`, `coasting`. |
| **Coasting** | A track with no fresh position updates (we use 30 s). The scope shows `CST`. |
| **Standard separation** | Terminal radar minimums: **3 NM lateral or 1,000 ft vertical**. |
| **Loss of separation (LoS)** | Two aircraft inside both minimums at the same time. |
| **Conflict alert (CA)** | A predicted LoS within the next 2 minutes. Shown as `CA` on both data blocks. |
| **Probe** | Checking a proposed clearance for conflicts and invalid values before it's issued. |
| **Unable** | Response when a clearance or request can't be accepted. Always followed by the reason and, if possible, an alternative. |
| **Track control** | Which sector currently owns an aircraft. |
| **Handoff** | Transfer of track control from one sector to another. The receiving controller accepts with "radar contact." |
| **Point out** | Telling an adjacent sector about an aircraft that will briefly affect its airspace, without transferring control. Reply: "point out approved." |
| **APREQ** | Approval request: asking another sector to approve an action that affects its traffic. Reply: "approved" or "unable" with a counter-proposal. |
| **CIC** | Controller-in-Charge: me, the human. I can issue clearances to any aircraft and override agents. |
| **Simplified minimum altitude floor** | Our stand-in for a real minimum vectoring altitude (MVA): field elevation + 1,500 ft within the radius. Label it "simplified floor" in the UI. Never call it an MVA. |

Phraseology rules for agents and the clearance echo:
- Callsign first, then the clearance: "Southwest twenty-one forty, descend and maintain four thousand."
- Air carrier flight numbers may be spoken in group form ("one twenty-three"). Headings and flight levels use single digits ("two seven zero", "flight level two three zero").
- Controller-to-controller handoff: "Handoff, United one twenty-three, seven thousand eight hundred climbing to one zero thousand, three miles north of the line." Reply: "United one twenty-three, radar contact."
- APREQ: "APREQ, Delta four fifty-six, turn left heading two seven zero for traffic United one twenty-three." Reply: "Delta four fifty-six, left heading two seven zero, approved."

---

## 3. Docs to read before coding

These SDKs change fast. Do not trust memory or this file for exact method names. Fetch and read these first, then confirm the real API:

- Terse docs index: https://docs.useterse.ai/llms.txt
- Terse quickstart: https://docs.useterse.ai/quickstart.md
- Terse TypeScript SDK reference: https://docs.useterse.ai/reference/typescript-sdk.md
- Terse examples: https://github.com/TerseAI/durable-actors/tree/main/examples
- Agent Relay docs (markdown): https://agentrelay.com/docs/markdown
- Agent Relay TypeScript SDK: https://agentrelay.com/docs/typescript-sdk (check the version selector and read the latest version)
- Agent Relay Observer (shows all messages, useful during the demo): https://agentrelay.com/observer
- Mastra docs (agents, tools, workflows, model router, structured output): https://mastra.ai/docs
- Anthropic current model names: https://docs.claude.com
- Deepgram speech-to-text (pre-recorded audio API, Nova-3, keyterm prompting): https://developers.deepgram.com
- ADS-B data (no key needed): `GET https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}`
- Airport data (public domain, no key): OurAirports `airports.csv` at https://davidmegginson.github.io/ourairports-data/airports.csv. Columns we need: `ident`, `type`, `name`, `latitude_deg`, `longitude_deg`, `elevation_ft`, `iso_country`, `iso_region`, `municipality`, `gps_code`, `iata_code`, `local_code`. Check the header row before parsing.

**Wrap each external SDK behind a small adapter module** (`relay.ts`, `actors.ts`, `stt.ts`) so that if an API shape differs from this file, only one file changes. All Mastra code lives in the `mastra/` package.

### What I already know about Mastra (verify)

- TypeScript agent framework. Runs on Bun. Package `@mastra/core`; scaffolding with `npm create mastra@latest` (don't use the scaffold if it fights our layout, just install the package).
- Agents: `new Agent({ id, name, instructions, model, tools })` from `@mastra/core/agent`. Call with `agent.generate(...)`; there is an option to cap tool-call steps.
- Models: either the model router string form (`"anthropic/<model-id>"`, reads `ANTHROPIC_API_KEY`) or the AI SDK provider (`anthropic("<model-id>")` from `@ai-sdk/anthropic`). Use whichever the current docs recommend.
- Tools: `createTool({ id, description, inputSchema, outputSchema?, execute })` from `@mastra/core/tools`, with Zod schemas.
- Structured output: `generate` supports returning an object matching a Zod schema. Check the current option name in the docs.
- Workflows: `createWorkflow` and `createStep` with typed input and output schemas, chained with `.then(...)` and finished with `.commit()`. Check current names in the docs.
- `mastra dev` opens a local playground for testing agents and tools. Use it only if it works quickly on my machine.
- **Mastra memory is off for this project.** Actors are the only source of truth. Each agent call gets the context it needs (event payload, sector picture, recent thread messages) in the prompt.

### What I already know about Terse (verify)

- Actors extend `Actor<Metadata, Incoming, Outgoing>` from `terse-sdk/actor`.
- Field decorators: `@Persisted` (saved to SQLite, restored on wake), `@Emittable` (with `@Persisted`, synced to connected clients), `@Ephemeral` (memory only).
- Persisted fields must be **reassigned** to save (`this.list = [...this.list, x]`). Mutating in place does not save.
- Socket hooks: `onConnect`, `onMessage`, `onDisconnect`. Send with `socket.send(...)` or `this.broadcast(...)`.
- **One alarm per actor:** `this.alarm.set(timestampMs)` replaces any earlier alarm. The runtime calls `onAlarm()`. To handle several deadlines, always set the alarm to the **earliest** pending deadline and recompute inside `onAlarm()`.
- Per-actor SQLite at `this.db` (`this.db.exec(sql, ...bindings)`, `this.db.transaction(async () => {...})`).
- Clients call `actors.<Class>.get(id).<method>(...)` through a generated client (`terse actor generate`).
- Browsers subscribe with a grant from `actors.<Class>.prepareWebsocket({ actorId, metadata })`, which returns a `websocketUrl`. Messages arrive as `state` (full emitted state) and `state_update` (changes). The backend should mint grants.
- Not documented: actor-to-actor calls and outbound `fetch` from inside actors. **Do not depend on either.** Actors only receive data pushed to them.
- CLI: `terse init`, `terse actor dev` (local server on port 7100), `terse actor generate`, `terse deploy`.

### What I already know about Agent Relay (verify)

- Package: `@agent-relay/sdk` (`bun add @agent-relay/sdk`).
- Newer versions can create a hosted workspace and register agents driven by our own code (for example `AgentRelay.createWorkspace(...)` and `register()`). We do **not** need to spawn Claude Code or Codex CLI agents. Our agents are our own Claude tool-use loops.
- Messages have roughly `{ from, to, text, threadId?, data? }`. There are DMs, channels, threads, and event listeners.
- Prebuilt broker binaries are published for Linux and macOS. **Avoid any feature that needs the local broker** (CLI agent spawning). If the hosted workspace path fails on Windows, move the project into WSL2.

### Verified at build time (Oct 31) — these override the notes above
- **Terse:** SDK/CLI 0.14.9. The local actor runtime has **no Windows build**, so only `terse actor dev` runs in WSL Ubuntu via `scripts/actor-dev.sh` (it rsyncs `actor/` + `shared/` into `/root/second-sight` and serves `127.0.0.1:7100`, reachable from Windows). Everything else runs on Windows. Terse treats **every class method (even private) as an async actor method**, so actor helpers are module-level functions. `state_update` = `{ changes: {field: fullNewValue}, removed: [], version }` (shallow merge). `this.alarm.delete()` exists. The generated client lives in `shared/adapters/generated/` (regenerate with `terse actor generate --out-dir shared/adapters/generated` while the dev server runs).
- **Agent Relay:** the `@agent-relay/sdk` TS SDK is broker-bound, so we use the hosted **Relaycast REST API** directly in `shared/adapters/relay.ts` (base `https://armadillo.agentrelay.com/v1`; `cast.` is slow/503s). Credentials persist in `.relay-identities.json` (gitignored). Structured `data` round-trips as message `metadata`. The hosted Observer UI only accepts `cast` keys, so the demo shows coordination in the app's Relay feed (or switch `RELAY_BASE_URL` to cast to use the Observer).
- **Mastra:** `@mastra/core` 1.81, model router strings `anthropic/<id>`, `generate(prompt, { maxSteps, structuredOutput: { schema } })` → `res.object`, tools `execute(inputData, context)`, workflows `createWorkflow().then(step).commit()` and `await wf.createRun()` → `run.start({ inputData })`.
- **Map tiles:** CARTO dark tiles now watermark without a key; the UI uses Esri World Dark Gray (no key). Override with `VITE_TILE_URL`.
- **Terminal-area filters (bridge):** TIS-B shadow targets (`~` hex duplicating an ICAO target) are dropped; VFR (squawk 1200) aircraft are excluded from CA pairs and handoffs; CA pairs where both aircraft are within 6 NM of the field and below 3,000 ft AGL (parallel approaches) are ignored.

---

## 4. Environment

- I'm on **Windows** and use **PowerShell** (env vars use `$env:NAME = "value"`, not `export`).
- Try native Windows first. If the Terse CLI or Agent Relay SDK fails, switch to WSL2 (Ubuntu) and keep going there. Don't spend more than 10 minutes fighting tooling.
- Runtime: **Bun** for everything (Terse requires Bun 1.4.2+).
- Browser: **Microsoft Edge** (Chromium). Microphone access works on `http://localhost`.
- LLM: **Claude via Mastra.** No direct Anthropic SDK calls. Read the model from env: `ANTHROPIC_MODEL_FAST` for the clearance parser agent (default `claude-haiku-5-5`) and `ANTHROPIC_MODEL_AGENT` for the sector controller and monitor agents (default `claude-sonnet-5-5`). Check https://docs.claude.com for current model names.
- Voice: **Deepgram for both directions** (I have credits). Speech-to-text with **Nova-3** (pre-recorded API, keyterm prompting for callsigns). Text-to-speech with **Aura-2** so the sector controllers talk back. Fallbacks: browser Web Speech API for input, `speechSynthesis` for output.
- Voice stack decision (don't revisit): we need push-to-talk transcription with custom vocabulary plus short spoken replies, not a phone-style conversational agent. Vapi and Deepgram's Voice Agent API run their own LLM loop and turn-taking, which would bypass our probe and Relay flow. AWS Transcribe needs more setup (IAM, custom vocabulary jobs) for no accuracy gain here. Azure is not set up.
- **Keep `ANTHROPIC_API_KEY` in the project `.env` only** (Bun loads it for the app). Do not set it in my PowerShell session or Windows user environment. I run Claude Code on my subscription, and a shell-level `ANTHROPIC_API_KEY` would make Claude Code bill the API key instead.

`.env` (never commit):
```
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL_FAST=claude-haiku-5-5
ANTHROPIC_MODEL_AGENT=claude-sonnet-5-5
DEEPGRAM_API_KEY=
DEEPGRAM_TTS_VOICE=       # any English Aura-2 voice; pick a calm, clear one from the Deepgram docs
TERSE_ACTOR_URL=          # local: http://127.0.0.1:7100/... (from terse actor dev output)
TERSE_API_KEY=            # only after terse deploy
RELAY_WORKSPACE_KEY=      # or whatever the current SDK calls it; persist after first create
DATA_SOURCE=live          # live | replay
DEFAULT_AIRPORT=          # optional, e.g. KSFO; if empty the UI asks at startup
RADIUS_NM=35
```

The airport is chosen at runtime in the UI and stored in the `Airspace` actor. It is not a required env var.

---

## 5. Repo layout

```
second-sight/
  CLAUDE.md
  API.md                     Backend ↔ frontend contract (endpoints, actor state shapes, UI display rules). Source of truth.
  actor/                     Terse actor project (Airspace, Aircraft)
  bridge/                    Bun service: ADS-B poller, replay, conflict alert, HTTP API, RADAR identity on Relay
  agents/                    Bun agent runner: one process per agent, chosen by CLI arg; wires Relay to Mastra agents
  mastra/                    Mastra package: agents/ (NORTH, SOUTH, MONITOR, clearance parser), tools/, workflows/clearance.ts
  shared/                    Pure TS: types, geometry, separation, conformance, probe, airports, telephony (+ bun tests)
  web/                       Vite + React + TypeScript UI
  scripts/build-airports.ts  Turns airports.csv into airports-us.json
  data/airports.csv          Raw OurAirports download (gitignored)
  data/airports-us.json      Generated lookup table of US airports (committed, small)
  data/recordings/<ICAO>/    Recorded ADS-B snapshots (JSONL) per airport, plus scenario.json
```

Run commands to document in a short README as we go:
- `terse actor dev` (in `actor/`) — on Windows: `wsl -d Ubuntu -u root -- bash scripts/actor-dev.sh`
- `bun run bridge`
- `bun run agent NORTH`, `bun run agent SOUTH`, `bun run agent MONITOR` (three terminals)
- `bun run web`

---

## 6. Architecture

```
 UI picks airport (KXXX) ──► BRIDGE validates via airports-us.json ──► Airspace.configure(airport)

 adsb.lol ──poll 5s──► BRIDGE ──push──► Airspace actor (airport, traffic, track control, handoffs, conflicts, feed)
                         │     └─push──► Aircraft actors (only aircraft with an active clearance)
                         │
                         │ RADAR identity posts events (BOUNDARY, CA, NONCONF, SESSION)
                         ▼
                   AGENT RELAY  ◄──────► NORTH sector controller   (Mastra agent, own process)
       #radar #coord #alerts #cic ◄────► SOUTH sector controller   (Mastra agent, own process)
                 DMs             ◄──────► MONITOR (conformance)     (Mastra agent, own process)
                         ▲                   │
                         │                   └─ tools call Terse actors directly
             CIC (me): voice or text clearances, overrides

 WEB UI ◄── websocket (state, state_update) ── Airspace actor (+ selected Aircraft actor)
        ──► BRIDGE HTTP: /airports, /session, /transcribe, /clearance, /cic, /grant
```

Three rules hold everywhere:
1. **All state lives in Terse actors.** The bridge and agents keep no state that matters.
2. **All agent-to-agent coordination goes through Relay.** Agents never call each other.
3. **Every clearance is probed before it's issued.** No exceptions, including CIC clearances. The CIC can override an "Unable", and the override is logged.

---

## 7. Data model (shared/types.ts)

```
Airport        { icao, name, city, state, lat, lon, elevationFt, radiusNm }
Position       { hex, callsign, registration|null, typeCode|null, lat, lon, altFt|null,
                 gsKt, trackTrueDeg, vertRateFpm, seenSec, ts }
Clearance      { kind: "altitude" | "heading", value: number, turn?: "left" | "right",
                 issuedAt, graceUntil, deadlineAt, issuedBy, phraseology }
ProbeResult    { ok: boolean, reasons: string[], conflicts: { with: callsign, minLatNm, minVertFt, inSec }[],
                 alternative?: Clearance }
AircraftState  { hex, callsign, clearance|null, track: Position[] (last 24), status, statusReason, sector }
Status         "none" | "pending" | "conforming" | "non_conforming" | "coasting"
Handoff        { hex, callsign, from, to, startedAt, dueAt, state: "pending" | "accepted" | "unable" | "overdue" }
ConflictAlert  { id, a: callsign, aHex, b: callsign, bHex, sectors: [s1, s2], predictedLatNm, predictedVertFt, inSec,
                 state: "active" | "coordinating" | "resolved" | "escalated", resolution?: string, dueAt }
FeedItem       { id, ts, from, to|channel, text }
```

**`API.md` section 2 has the exact TypeScript types and wins over this summary.** Anything the UI sees (endpoints, actor state, WebSocket messages) must match `API.md`. Changing it needs both teammates to agree.

ADS-B notes: readsb-style JSON with an `ac` array. Expect fields like `hex`, `flight` (callsign, padded with spaces), `r` (registration), `t` (ICAO type), `lat`, `lon`, `alt_baro` (number, or the string `"ground"`), `gs`, `track`, `baro_rate`, `seen`. **Verify against one real response before coding the parser.** Drop aircraft on the ground, below 1,000 ft above field elevation, or with `seen > 30`.

Altitude note: `alt_baro` is pressure altitude referenced to 29.92 inHg. Below FL180 real scopes correct it with the local altimeter setting. Our ±300 ft conformance tolerance absorbs most of the difference. Applying the local altimeter from METAR is a stretch item.

---

## 8. Actors (actor/)

### `Airspace` (single instance, id `"main"`)
Emittable persisted fields:
- `airport`: the active `Airport`, or `null` before one is chosen
- `traffic`: compact list of every aircraft in range `{ hex, callsign, lat, lon, altFt, vertRateFpm, gsKt, trackTrueDeg, status, sector, ca: boolean }`
- `trackControl`: map `hex -> "NORTH" | "SOUTH"`
- `handoffs`: list of `Handoff`
- `conflicts`: list of `ConflictAlert` (active plus last 10 resolved)
- `feed`: last 100 `FeedItem`s (Relay messages mirrored by the bridge)
- `alerts`: last 20 alerts

Methods:
- `configure(airport)` sets the active airport and clears `traffic`, `trackControl`, `handoffs`, `conflicts`, and `alerts` in one transaction. Keeps `feed` but appends `Now controlling KXXX (name)`. Clears the alarm.
- `updateTraffic(batch)` called by the bridge every poll. Ignored if `airport` is null. Assigns track control by geometry for aircraft not yet owned and not in a pending handoff. Removes aircraft that left.
- `setStatus(hex, status, reason)`
- `initiateHandoff(hex, from, to)` fails if `from` doesn't have track control or a handoff is already pending. `dueAt = now + 30s`.
- `acceptHandoff(hex, by)` atomically transfers track control to `by` and marks the handoff accepted. Rejects if `by` isn't the receiving sector.
- `rejectHandoff(hex, by, reason)` sets state `unable`.
- `raiseConflict(alert)` / `updateConflict(id, patch)` / `clearConflict(id)`. New conflicts get `dueAt = now + 30s`.
- `appendFeed(item)`, `addAlert(alert)`
- `onAlarm()`: marks pending handoffs past `dueAt` as `overdue`, marks unresolved conflicts past `dueAt` as `escalated` (alert to CIC), then re-arms the alarm for the next earliest `dueAt`.

### `Aircraft` (id = ICAO hex, created when the first clearance is issued)
Emittable persisted fields: `callsign`, `clearance`, `track` (last 24 positions), `status`, `statusReason`.
Methods:
- `issueClearance(clearance)` sets status `pending` and arms the alarm for `graceUntil`. Grace and deadline: altitude 20 s grace, 60 s deadline. Heading 15 s grace, 45 s deadline.
- `ingestPosition(pos)` appends to track, runs `evaluateConformance` (from `shared/`), updates status, returns `{ status, changed, reason }`.
- `onAlarm()`: re-evaluates at `graceUntil` and `deadlineAt`. If no position for 30 s, set `coasting`. Re-arm for the next check (every 10 s while a clearance is active).
- `broadcast` a `{ type: "status", ... }` message whenever status changes.

---

## 9. Deterministic logic (shared/, unit-tested with `bun test`)

Write tests for separation, conformance, and probe first. They're the core and they're quick.

- **Airport lookup (`airports.ts`):** load `data/airports-us.json`. Normalize input (trim, uppercase). Match on `ident`, then `gps_code`. A 3-letter code also works: try `K` + code, then `iata_code`, then `local_code`. On no match, return the 5 closest codes by prefix. `scripts/build-airports.ts` keeps rows where `iso_country == "US"` and `type` is `large_airport`, `medium_airport`, or `small_airport`.
- **Sectors:** center = the active airport, radius `RADIUS_NM`. The boundary is the east-west line (latitude) through the airport. NORTH is above it, SOUTH below. All geometry takes the airport as a parameter.
- **Magnetic variation:** ADS-B track is true; clearances assign magnetic headings. Convert with a World Magnetic Model package from npm (find one that works offline, e.g. `geomagnetism`). Compute declination once per airport on `configure`. Magnetic = true − east declination.
- **Projection:** straight-line projection from `gs` and `track`, plus `vertRateFpm`, sampled every 10 s for 120 s.
- **Separation check:** a pair loses separation at a sample if lateral < 3 NM **and** vertical < 1,000 ft. Use haversine distance in NM.
- **Conflict alert (`conflictAlert`):** for all airborne pairs, project both aircraft. If any sample loses separation, return a CA with the first time, minimum lateral, and minimum vertical. Ignore pairs where both are below 1,000 ft above field elevation (final approach to parallel runways would false-alarm).
- **Clearance probe (`probeClearance`):** given an aircraft, a proposed clearance, and current traffic:
  - **Validity:** heading 001 to 360. Altitude from the simplified floor to FL450, in 100 ft steps. Altitudes at or above 18,000 ft must be expressed as flight levels.
  - **Simplified floor:** reject altitudes below field elevation + 1,500 ft. Reason: "Below simplified minimum altitude floor."
  - **Conflict probe:** model the cleared aircraft's new profile (climb or descend at max(|current rate|, 1,500 fpm) toward the cleared altitude; for a heading, turn at standard rate, 3° per second, then fly straight) and project others straight. Any loss of separation in 120 s fails the probe.
  - **Alternative:** for a failed altitude clearance, search 1,000 ft steps toward the original altitude for the closest value that passes. For a failed heading, try ±20° and ±40°. Return the first that passes, or none.
- **Altitude conformance:** within 300 ft of the cleared altitude = `conforming`. Moving toward it at more than 500 fpm = `conforming` (in progress). After the grace period, moving away from it at more than 500 fpm = `non_conforming`. No progress by the deadline = `non_conforming`. Reason strings are plain English: `Cleared to 4,000. Now 7,800 and climbing 1,800 fpm.`
- **Heading conformance:** magnetic track within 20° of the cleared heading = `conforming` (the 20° allows for wind). Turning in the cleared direction toward it = `conforming`. Otherwise `non_conforming` after the grace period.
- **Boundary approach:** project 90 s ahead. If the projected point is in the other sector and the aircraft is within 4 NM of the boundary, emit `BOUNDARY` once per aircraft per crossing.
- **Telephony (`telephony.ts`):** map ICAO airline prefixes to telephony designators: `UAL` United, `DAL` Delta, `AAL` American, `SWA` Southwest, `ASA` Alaska, `JBU` JetBlue, `SKW` SkyWest, `FFT` Frontier Flight, `NKS` Spirit Wings, `HAL` Hawaiian, `FDX` FedEx, `UPS` UPS, `RPA` Brickyard, `ENY` Envoy, `EDV` Endeavor, `AAY` Allegiant, `QXE` Horizon. Extend as needed. N-numbers are spoken with the phonetic alphabet ("November three four five alpha bravo").
- **Phraseology (`phraseology.ts`):** turn a `Clearance` + callsign into the standard spoken form for the clearance echo and for text-to-speech. Examples: "United one twenty-three, climb and maintain one zero thousand." "Delta four fifty-six, turn left heading two seven zero." "JetBlue eight eleven, descend and maintain flight level two four zero."

---

## 10. Voice clearances

Push-to-talk, like a real radio.

- **UI:** hold the **spacebar** (or a big PTT button) to transmit. Show a "TRANSMITTING" indicator. Record with `MediaRecorder`. On release, send the audio to `POST /transcribe`.
- **Bridge `/transcribe`:** send the audio to Deepgram's pre-recorded API with `model=nova-3` and `smart_format=true`. Use **keyterm prompting**. Nova-3 accepts **up to 100 keyterms per request**, so build the list in priority order and stop at 100: ATC phrases ("climb and maintain", "descend and maintain", "flight level", "turn left heading", "turn right heading"), then telephony designators for airlines currently in range, then spoken callsigns ("United one twenty-three") starting with the selected aircraft and aircraft with active clearances, then the rest sorted by distance. Never expose the Deepgram key to the browser.
- **Fallback:** if Deepgram fails or isn't configured, use the browser Web Speech API (`webkitSpeechRecognition`) and send the text instead.
- **Parse:** the transcript goes through the same path as typed text (`POST /clearance`, which runs the clearance workflow in section 11a). The **clearance parser** is a Mastra agent on the fast model. It gets the list of current callsigns with their spoken forms and returns structured output matching a Zod schema: `{ callsign, kind, value, turn? }`. Validate with the shared types. It must handle ATC number forms ("one zero thousand", "flight level two three zero", "two seven zero").
- **Show the loop:** transcript → parsed clearance echoed in standard phraseology → probe result → issued or "Unable". This takes about 2 seconds and reads well on a projector.
- **Text-to-speech:** speak sector controller messages addressed to the CIC (the "Unable…" reply, APREQ outcomes, escalations) with Deepgram **Aura-2** through `POST /speak`, so the scope talks back. Use one voice per sector if two good voices are available, so NORTH and SOUTH sound different. Queue clips so they never overlap. Fall back to `speechSynthesis` if `/speak` fails. Mute toggle in the header.

---

## 11. Bridge (bridge/)

- **Airport session:** reads `Airspace.airport` on startup. If null and `DEFAULT_AIRPORT` is set, configures that airport. The poller does nothing until an airport is set. When the airport changes, reset in-memory caches and post `SESSION KXXX (name) started, radius 35 NM` to `#radar`.
- **Poller:** every 5 s, fetch ADS-B for the active airport's lat, lon, and radius. Normalize to `Position[]`. Call `Airspace.updateTraffic`. For each hex with an `Aircraft` actor, call `ingestPosition`; if `changed`, call `Airspace.setStatus` and, if it became `non_conforming`, post `NONCONF` to `#radar`.
- **Conflict alert loop:** after each poll, run `conflictAlert` over the traffic. Raise new CAs on the `Airspace` actor and post `CA` to `#radar`. Clear CAs that are no longer predicted. Debounce so a flickering pair doesn't re-alert within 30 s.
- **Recorder:** in live mode, append every raw snapshot to `data/recordings/<ICAO>/<timestamp>.jsonl`. **Start recording in Phase 1 so we have replay data later.**
- **Replay:** `DATA_SOURCE=replay` plays the newest recording for the active airport at real speed in a loop. If none exists, return a clear error to the UI. `data/recordings/<ICAO>/scenario.json` can bend one aircraft's altitude or track over time, or inject one synthetic aircraft (callsign prefixed `SIM`) to create a guaranteed conflict. The UI shows a `REPLAY` badge whenever replay is on.
- **RADAR identity on Relay:** posts machine events to `#radar` in a fixed, readable format, with the structured payload in the message `data` field so agents don't parse text:
  - `BOUNDARY UAL123 NORTH->SOUTH in 2.5 NM, 078 climbing`
  - `CA UAL123/DAL456 predicted 1.8 NM / 400 FT in 70 s (NORTH/SOUTH)`
  - `NONCONF SWA2140 cleared 040, now 078 climbing 1,800 fpm (owner SOUTH)`
  - `SESSION KSFO (San Francisco Intl) started, radius 35 NM`
- **Feed mirror:** subscribe to all Relay channels (or the workspace-level event stream if the SDK has one) and call `Airspace.appendFeed` for each message so the UI shows the coordination.
- **HTTP API for the UI:**
  - `GET /airports/:code` returns the matching `Airport` or `{ error, suggestions }`.
  - `POST /session { code }` validates, calls `Airspace.configure`, restarts the poller.
  - `POST /transcribe` (audio body) returns `{ transcript }`.
  - `POST /speak { text, voice? }` calls Deepgram Aura-2 and returns audio. Cache by text so repeats are instant.
  - `POST /clearance { text, override?: boolean }` runs the **clearance workflow** (section 11a) and returns its result: `{ issued: true, phraseology }` or `{ issued: false, reason, alternative }`. Stream step progress to the UI if easy (parsed, probed, awaiting sector, issued) so the loop is visible on screen.
  - `POST /cic { text }` posts to `#cic` as the CIC.
  - `GET /grant?actor=Airspace&id=main` (or `Aircraft` and a hex) returns a websocket grant from `prepareWebsocket`.

---

## 11a. Clearance workflow (mastra/workflows/clearance.ts)

A Mastra workflow run by the bridge for every clearance, voice or typed. Each step has a Zod input and output schema.

1. **parse:** clearance parser agent turns text into `{ callsign, kind, value, turn? }`. On failure, end with "Say again" and the closest callsigns.
2. **resolve:** match the callsign against `Airspace.traffic` (plain code, using `telephony.ts`). Look up the controlling sector from `trackControl`.
3. **probe:** run `probeClearance` from `shared/` (plain code). Attach the `ProbeResult`.
4. **sectorReview:** DM the controlling sector agent over Relay with the parsed clearance and probe result in `data`. Wait up to 8 s for its reply. The agent either issues it (it calls `issue_clearance`) or replies "Unable" with a reason and alternative. If no reply in 8 s, return "No response from sector" and let the CIC decide.
5. **result:** return `{ issued, phraseology }` or `{ issued: false, reason, alternative }`.

With `override: true` (CIC override), skip step 4, issue directly, post the override and the probe warnings to `#cic`.

---

## 12. Agents (agents/ + mastra/agents/)

Each agent is a **Mastra `Agent`** defined in `mastra/agents/` with its instructions, the agent model, and its Mastra tools. The runner in `agents/` connects it to Relay.

One runner, three identities: `bun run agent NORTH | SOUTH | MONITOR`. Each process:
1. Connects to the Relay workspace with its own identity.
2. Listens to its channels and DMs.
3. On a relevant message, calls the Mastra agent's `generate` with the message, its structured `data`, and recent messages from the same thread. Cap tool-call steps at 4. Debounce so the same event never triggers two calls.

Tools are **Mastra tools** (`createTool` with Zod input schemas) in `mastra/tools/`, thin wrappers over the actor client, shared logic, and the Relay adapter:
- `get_sector_picture(sector)` active airport, aircraft under the sector's track control (altitude, vertical rate, track, status), pending handoffs, and active CAs.
- `probe_clearance(callsign, kind, value, turn?)` runs `probeClearance` on fresh traffic.
- `issue_clearance(callsign, kind, value, turn?)` creates or updates the `Aircraft` actor. Only allowed after a passing probe in the same turn, or with a CIC override flag.
- `initiate_handoff(callsign, to)`, `accept_handoff(callsign)`, `reject_handoff(callsign, reason)`
- `update_conflict(id, state, resolution?)`
- `send_dm(to, text)` / `post(channel, text)`

Behavior:
- **NORTH / SOUTH (sector controllers).**
  - **Clearance request from the CIC** (DM from the bridge): check the probe result. If it passes, `issue_clearance` and reply with the phraseology. If it fails, reply on `#cic`: "Unable, United one twenty-three to eight thousand, traffic Delta four fifty-six, eight thousand, two miles ahead. Suggest seven thousand." Never issue a failed clearance without a CIC override.
  - **`BOUNDARY` for an aircraft it controls:** `initiate_handoff`, then DM the other sector in standard handoff phraseology.
  - **Incoming handoff:** check `get_sector_picture` for traffic within 3 NM and 1,000 ft of the projected entry point. If clear, `accept_handoff` and reply "radar contact." If not, `reject_handoff` and reply "Unable" with the traffic and a suggestion.
  - **`CA` in its own sector only:** pick a resolution (stop a climb or descent short, or a heading change), `probe_clearance` it, post the resolution to `#coord` as an advisory to the CIC, and `update_conflict` to `coordinating`.
  - **`CA` across both sectors:** the sector that controls aircraft `a` sends an **APREQ** DM to the other sector proposing who maneuvers. The other sector approves or replies "Unable" with a counter-proposal. Two rounds maximum, then `update_conflict` to `escalated` and post to `#cic`. On agreement, post the plan to `#coord` and set `resolved` with the plan as `resolution`.
  - **`NONCONF` DM from MONITOR about its own aircraft:** post a one-line action to `#alerts`.
- **MONITOR (conformance).** On `NONCONF`: write a two-sentence plain-English explanation from the structured payload (never invent numbers), post it to `#alerts`, and DM the controlling sector.
- **CIC (me).** Messages in `#cic` reach all agents. Agents follow reasonable directions like "SOUTH, stop accepting handoffs for two minutes," acknowledge, and change behavior for that window.

System prompts must say: be brief, use the terminology and phraseology in section 2, only use numbers from tool results or event payloads, and never claim an action happened unless the tool call succeeded.

Agents must not assume an airport. They read it from `get_sector_picture` or the latest `SESSION` message and drop pending work from the previous airport when a new `SESSION` arrives.

---

## 13. Web UI (web/)

Vite + React + TypeScript + Leaflet with a dark basemap (CARTO dark tiles, no key). Readability on a projector beats polish.

- **Start screen:** shown when `Airspace.airport` is null. One input: "Enter a US airport code (e.g. KSFO)". Validate as I type with `GET /airports/:code`; show the airport name and city on match, suggestions otherwise. Enter calls `POST /session`. Quick-pick chips: `KSFO`, `KLAX`, `KJFK`, `KATL`, `KORD`, `KDFW`.
- **Header:** airport code and name, aircraft count, `LIVE` or `REPLAY` badge, TTS mute, "Change airport". If fewer than 5 aircraft are in range after 20 s, show "Quiet airspace. Try a busier airport."
- **Scope (center):** centered on the airport. Draw range rings every 10 NM and the sector boundary. Each target is a small symbol with a leader line to its **data block** (`UAL123` / `078↑ 28`). Color by status: white `none`, amber `pending`, green `conforming`, red `non_conforming`, gray `coasting` (with `CST`). Tint by controlling sector. Pending handoffs blink. Aircraft in a CA show `CA` in red on the data block and a line connecting the pair.
- **Left panel:** push-to-talk button + text input for clearances, with the transcript, phraseology echo, and probe result. A "Climbing / Descending" filter to quickly find aircraft with vertical rate over 500 fpm (useful for the demo). List of aircraft with active clearances, their status and reason. Active conflict alerts with state.
- **Right panel:** live Relay feed from `Airspace.feed`, color-coded by sender, filters for `#radar`, `#coord`, `#alerts`, `#cic`. CIC text input at the bottom.
- **Unable card:** when a clearance comes back "Unable", show the reason, the suggested alternative as a one-click "Issue alternative" button, and a smaller "CIC override" button.
- **Detail card:** click an aircraft to subscribe to its `Aircraft` actor: clearance, status reason, small altitude chart from `track`.
- State comes from websockets opened with `/grant` URLs. Apply `state`, then `state_update`. No polling.

---

## 14. Build phases (time-boxed)

Commit at the end of every phase. After each phase, tell me in three lines what works and how to run it. If a phase runs long, cut from section 16 instead of extending.

**Phase 0: setup (10:00 to 11:00, before hacking starts, no project code)**
Install Bun and the Terse CLI (`bunx terse-cli@latest install`). Confirm `terse` runs. Install the Agent Relay SDK in a scratch folder and confirm it imports. Have Anthropic and Deepgram keys ready. Download `airports.csv` into `data/` (it's data, not code). Read the docs in section 3.

**Phase 1: airport and live scope (11:00 to 11:50)**
Scaffold the repo. Airport build script + lookup. Types + ADS-B normalizer. `Airspace` actor with `configure`, `updateTraffic`, `airport`, `traffic`. Bridge `/airports/:code`, `/session`, poller, recorder, `/grant`. Start screen + scope with data blocks.
*Done when:* I can type `KSFO`, then `KJFK`, and see real aircraft move with correct data blocks, and recordings are being written per airport.

**Phase 2: clearances, probe, conformance (11:50 to 12:50)**
Separation, probe, conformance, magnetic variation, phraseology, telephony, all with tests. `Aircraft` actor. Install Mastra. Clearance parser agent. Clearance workflow with steps parse, resolve, probe, result (add sectorReview in Phase 3). `/clearance` runs the workflow and issues directly for now. Unable card using the probe result. Status colors and detail card.
*Done when:* I type "Southwest twenty-one forty, descend and maintain four thousand" at a climbing aircraft, it goes amber then red with the right reason, and a clearance into traffic comes back "Unable" with an alternative.

**Lunch (12:50 to 1:15).** Let the recorder keep running at a busy airport.

**Phase 3: Relay agents, handoffs, conflict alert (1:15 to 2:20)**
Relay adapter, workspace, RADAR identity, channels, feed mirror. Mastra tools and the NORTH, SOUTH, MONITOR Mastra agents. Agent runner connecting them to Relay. Add the sectorReview step to the clearance workflow. Track control in `updateTraffic`. Handoff methods. Conflict alert loop. Same-sector and cross-sector (APREQ) resolution. `Airspace` alarm for overdue handoffs and escalated CAs.
*Done when:* a boundary crossing produces a handoff and "radar contact" with track control flipping on the scope, and a cross-sector CA produces an APREQ exchange that ends resolved or escalated.

**Phase 4: voice (2:20 to 2:55)**
Push-to-talk recording, `/transcribe` with Deepgram Nova-3 and keyterms, Web Speech fallback, transcript-to-clearance loop on screen, `/speak` with Aura-2 for controller replies to the CIC.
*Done when:* I can say "United one twenty-three, climb and maintain one zero thousand" and see it parsed, probed, and issued.

**Phase 5: replay scenario and polish (2:55 to 3:25)**
Replay mode + `scenario.json` for one busy airport (whichever has the best recording, likely `KSFO`). The scenario must produce, within 2 minutes: a cross-sector CA that leads to an APREQ, and a clean handoff. UI cleanup.
*Done when:* the scenario runs the same way three times in a row.

**Phase 6: rehearse and submit (3:25 to 3:55)**
README with a short "Why" section from 2a (with source links), run commands, and a one-paragraph architecture note. Product name in the UI header: **Second Sight**. Record a 60-second backup video. Rehearse the demo twice. Submit.

---

## 15. Demo script (3 minutes)

1. Open with the story (section 2a): "In 2002 over Überlingen, one controller was covering two sectors alone, the conflict alert was off for maintenance, and the phone line to the next sector was dead. 71 people died. Today the US is about 1,600 certified controllers short of the FAA's own target. Second Sight is an AI second set of eyes for every sector, for any airport in the US."
2. Ask a judge for their home airport code, type it in, and show live traffic. Then switch to `KSFO`.
3. **Conforming:** filter for climbing aircraft. Hold push-to-talk: "[Callsign], climb and maintain [an altitude above its current one]." It goes amber, then green. "It's already climbing, so it conforms."
4. **Non-conforming:** pick another climbing aircraft. "[Callsign], descend and maintain four thousand." After the grace period it goes red, and MONITOR explains in plain English. "The real aircraft can't hear us, so it keeps climbing. That's exactly the non-conformance a controller needs to catch."
5. **Unable:** clear an aircraft into another one's altitude. The sector controller replies "Unable" out loud with the traffic and a safer altitude. Click "Issue alternative."
6. **Switch to replay (badge shows `REPLAY`).** A cross-sector conflict alert fires. NORTH sends an APREQ to SOUTH, SOUTH counter-proposes, they agree. Open the Relay Observer to show the messages are real.
7. A handoff happens: "Handoff… radar contact." Track control flips on the scope.
8. Close: "Second Sight never goes off shift. Every aircraft is a durable actor with its own timer. One actor owns track control, so an aircraft can never belong to two sectors. Every controller is a Mastra agent in its own process, and the only way they coordinate is Agent Relay."

---

## 16. Cut list (cut from the top if behind)

1. Detail card altitude chart
2. Aura-2 text-to-speech (fall back to browser `speechSynthesis`, or no spoken replies)
3. 3-letter code convenience and suggestions (keep exact 4-letter lookup)
4. CIC directions changing agent behavior
5. Heading clearances (keep altitude only; drop magnetic variation with them)
6. Rejected handoffs and overdue handoffs (keep accepted handoffs)
7. Same-sector CA resolution (keep cross-sector APREQ)
8. Deepgram speech-to-text (keep the Web Speech API path)
9. Deploying with `terse deploy` (demo from local)

Never cut: airport picker, live scope with data blocks, altitude clearances, the probe with "Unable", conformance monitoring, cross-sector conflict alert with APREQ over Relay, handoff with atomic track control transfer, push-to-talk voice (Web Speech at minimum), replay mode.

## 17. Stretch (only if everything above is done)

- Apply the local altimeter setting from METAR to altitudes below FL180.
- A simulated pilot readback after each issued clearance, clearly labeled "SIMULATED READBACK".
- A shift summary from MONITOR at the end of the session, built from the `Airspace` feed and alerts.
- Point outs when a resolution heading briefly takes an aircraft into the other sector.

---

## 18. Working rules for you (Claude Code)

- Read the docs in section 3 before writing SDK code. If the real API differs from this file, follow the docs and update this file.
- Use the terminology in section 2 in names, UI text, and prompts. If you're unsure of a term, ask me rather than inventing one.
- Build in phase order. Get each phase running end to end before starting the next.
- Keep deterministic logic in `shared/` as pure functions with tests. Keep Claude calls out of anything that decides state or safety. Mastra tools and workflow steps call the `shared/` functions; they never reimplement them.
- Never hardcode keys. Never commit `.env`, `data/airports.csv`, or recordings over 20 MB.
- No fake data in live mode. Simulated aircraft and bent tracks only appear in replay mode, behind the `REPLAY` badge.
- Prefer boring, working code over clever code. Ask me before any refactor that touches more than two packages.
