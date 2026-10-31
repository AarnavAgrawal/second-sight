# ai-updates.md: Give the AI controllers real judgment

Read this after `CLAUDE.md` and `API.md`. It upgrades the sector controller agents (NORTH, SOUTH) from "turn the probe result into phraseology" into **a second controller that chooses, remembers, and coordinates**. Everything in `CLAUDE.md` still applies unless this file says otherwise.

---

## 1. The problem this fixes

In the current design, the clearance review is thin: the probe (math) decides safe or unsafe, the probe picks the alternative, and the agent only words the result. A judge could fairly call it "an if-statement with a nice voice."

After this change, the split is:
- **Math answers "is it safe?"** Separation, probes, conformance, candidate generation. Unchanged, still in `shared/`.
- **The AI answers "is it the right call?"** It picks between safe options using context, remembers agreements made with the other sector, notices when coordination is needed, questions contradictory clearances, and asks "say again" when speech is unclear.

Pitch line: **"You talk to the aircraft. Math guarantees separation. The AI does what a second controller does: chooses, remembers, and coordinates."**

---

## 2. The safety rule (non-negotiable)

**The AI may only choose from options the math has already validated.**

- Every option an agent can pick (alternative clearances, conflict resolutions, handoff conditions) is a **candidate** generated and probed by `shared/` code.
- The agent returns a candidate **id**, never its own numbers. The workflow looks up the candidate by id and uses the math's values.
- If the agent returns an id that doesn't exist, returns invalid output, or times out, the workflow falls back to a **deterministic default** (section 9). The demo must never hang or issue something unvalidated because the AI misbehaved.
- The agent never issues a clearance whose probe failed. Only a CIC override does that (unchanged).

---

## 3. New deterministic facts (shared/, with tests)

Add these pure functions. The AI reasons over their output; it never computes them itself.

### 3a. Candidate generation: `generateCandidates(aircraft, requested, traffic, airport)`
Returns 3 to 6 **safe** candidates (each one passes `probeClearance`), sorted by smallest deviation from what the CIC requested.

```
Candidate {
  id: string                 // "c1", "c2", ...
  kind: "altitude" | "heading"
  value: number
  turn?: "left" | "right"
  phraseology: string        // standard form, from phraseology.ts
  deviation: number          // how far from the requested clearance (ft or degrees)
  tags: string[]             // facts about this option, see below
}
```
Search space: altitudes in 1,000 ft steps within ±4,000 ft of the requested altitude (respecting the simplified floor and FL rules), and headings at ±20°, ±40°, ±60° from the requested heading (or from current track if the request was an altitude).

Tags (computed, not guessed):
- `keeps_climb` / `stops_climb` / `keeps_descent` / `stops_descent`
- `enters_other_sector_120s`: projected position crosses the boundary within 120 s
- `breaks_agreement:<agreementId>`: violates an active agreement (3c)
- `toward_airport` / `away_from_airport`
- `large_deviation`: more than 2,000 ft or 40° from the request

### 3b. Flight phase: `flightPhase(aircraft, airport)`
- `departure`: within 25 NM of the airport, climbing at 500 fpm or more, distance to airport increasing
- `arrival`: within 40 NM, descending at 500 fpm or more, distance decreasing
- `overflight`: everything else
Label it "estimated phase" in the UI. It's a heuristic, not a flight plan.

### 3c. Agreements: `checkAgreements(callsign, clearanceOrCandidate, agreements)`
Returns the list of active agreements the clearance would break.

```
Agreement {
  id: string
  hex: string
  callsign: string
  constraint: { kind: "altitude" | "heading", op: "maintain" | "at_or_below" | "at_or_above", value: number }
  between: ["NORTH", "SOUTH"]
  source: "APREQ" | "handoff" | "CIC"
  text: string               // "DAL456 maintain 6,000 until clear of JBU811 (APREQ)"
  createdAt: number
  expiresAt: number          // default 5 minutes
}
```

### 3d. Recent clearance check: `recentConflictingClearance(aircraftState, requested, now)`
Returns the previous clearance if one was issued less than 60 s ago **and** the new one reverses direction (climb vs descend, left vs right) or changes by more than 3,000 ft or 60°. Otherwise `null`.

### 3e. Sector entry: `sectorEntry(aircraft, candidateOrRequested, airport)`
Returns `{ entersOther: boolean, inSec?: number, sector?: Sector }` using the same 120 s projection.

---

## 4. New state in the `Airspace` actor

Add two persisted, emittable fields. All memory lives here, not in Mastra (memory stays off).

- `agreements: Agreement[]` (active and last 10 expired)
- `directives: Directive[]`

```
Directive {
  id: string
  target: "NORTH" | "SOUTH" | "ALL"
  text: string               // the CIC's words
  rule?: { type: "no_handoffs" | "altitude_cap" | "altitude_floor" | "other", value?: number }
  createdAt: number
  expiresAt: number          // default 5 minutes, or the duration the CIC said
}
```

New methods:
- `addAgreement(a)`, `expireAgreement(id)`
- `addDirective(d)`, `expireDirective(id)`
- `onAlarm()` also expires agreements and directives past `expiresAt` (same "earliest deadline" alarm pattern as handoffs and conflicts).

Where agreements come from:
- **APREQ resolved:** the agreed plan becomes one agreement per constrained aircraft.
- **Handoff accepted with a condition:** "radar contact, maintain seven thousand" becomes an agreement.
- **CIC directive with an aircraft-specific constraint:** becomes an agreement.

Where directives come from: CIC messages in `#cic` are parsed by the agent that's addressed (structured output into `Directive`) and stored with `addDirective`. Agents always receive active directives in their context.

---

## 5. Upgraded clearance workflow

Replace the workflow in `CLAUDE.md` section 11a with these steps:

1. **parse:** clearance parser agent → `{ callsign, kind, value, turn?, confidence: "high" | "low", ambiguousWith?: string[] }`. If `confidence` is `low` or the callsign matches more than one aircraft, stop and return "Say again" with the candidates (see 5a).
2. **resolve:** find the aircraft and the controlling sector (unchanged).
3. **probe:** `probeClearance` on the requested clearance (unchanged).
4. **context** (new, plain code): build the facts packet for the agent:
   - flight phase (3b)
   - candidates (3a), always generated, even if the request passed the probe
   - agreements the request would break (3c)
   - recent conflicting clearance (3d)
   - sector entry (3e)
   - active directives for this sector
5. **sectorReview:** DM the controlling sector agent with the request, probe result, and facts packet in `data`. The agent must end by calling the **`submit_review`** tool (section 6). Timeout 8 s.
6. **coordinate** (new, only if the review decision is `coordinate`): send the point out or APREQ the agent wrote to the other sector over Relay and wait up to 6 s for "point out approved" / "approved". On approval, continue to issue. On "unable" or timeout, return Unable with the other sector's reason.
7. **result:** act on the decision (section 6) and return the response.

### 5a. Better "say again"
The parser agent gets the transcript, the list of callsigns in range with spoken forms, and the last 3 clearances issued. It returns `confidence: "low"` when:
- the callsign is only a partial match or matches two aircraft ("Southwest twenty-one" when SWA2140 and SWA2155 are both in range)
- the altitude or heading is missing or garbled
Response phrasing: "Say again, which Southwest, twenty-one forty or twenty-one fifty-five?"

---

## 6. The `submit_review` tool

A Mastra tool the sector agent must call exactly once to finish a review. The workflow acts on it; the agent doesn't issue anything directly in the review path.

Input schema:
```
{
  decision: "issue" | "unable" | "confirm" | "coordinate",
  chosenCandidateId?: string,     // required for "unable" when any candidate exists; the recommended alternative
  phraseology: string,            // what the controller says (spoken to the CIC)
  reason: string,                 // one or two sentences: WHY this decision / this option
  question?: string,              // required for "confirm"
  coordinationMessage?: string    // required for "coordinate": the point out or APREQ text to send
}
```

Validation (in the workflow, not the prompt):
- `issue` is only allowed if the requested clearance's probe passed **and** it breaks no agreement **and** there's no recent conflicting clearance. Otherwise reject the review and apply the fallback.
- `chosenCandidateId` must exist in the facts packet.
- `coordinate` is only allowed when `sectorEntry.entersOther` is true or an agreement with the other sector would be affected.
- `confirm` is only allowed when a recent conflicting clearance or a broken agreement exists.

What each decision does:
- **issue:** issue the requested clearance (existing `Aircraft.issueClearance`).
- **unable:** don't issue. Return the reason and the chosen candidate as the suggested alternative (CIC can click "Issue alternative").
- **confirm:** don't issue. Return a question to the CIC ("Confirm, United one twenty-three was cleared to four thousand thirty seconds ago?"). If the CIC confirms, the request is resent with `confirmed: true`, and the review runs again with that fact.
- **coordinate:** run the coordinate step (5, step 6), then issue on approval.

---

## 7. Agent behavior changes (mastra/agents/)

Add to the NORTH and SOUTH instructions:

**Reviewing a clearance**
- Read the facts packet first. Never compute numbers yourself.
- If the request is safe, breaks no agreement, has no recent contradiction, and doesn't enter the other sector: `issue`.
- If it's unsafe or breaks an agreement: `unable`, and pick the **best** candidate using these preferences, in order:
  1. No `breaks_agreement` tag.
  2. No `enters_other_sector_120s` tag, unless there's no other choice.
  3. **Departures:** prefer options with `keeps_climb`. Avoid stopping a departure's climb low.
  4. **Arrivals:** prefer altitude changes over large turns, and options `toward_airport`.
  5. **Overflights:** smallest deviation.
  6. Avoid `large_deviation` when a smaller safe option exists.
- If it's safe but `enters_other_sector_120s`: `coordinate` with a point out: "Point out, United one twenty-three, eight miles north of the line, climbing to one zero thousand, will enter your airspace in about ninety seconds."
- If a recent conflicting clearance exists, or the request breaks an agreement the CIC may not know about: `confirm` with a short question.
- `reason` must name the deciding facts in plain words: "Keeps the departure climbing and stays out of SOUTH's airspace."

**Handoffs**
- Before accepting, check: traffic near the projected entry point, active directives (for example, a `no_handoffs` directive), and agreements.
- Three outcomes: accept ("radar contact"), **accept with a condition** chosen from math-generated candidates ("United one twenty-three, radar contact, maintain seven thousand", which creates an agreement), or "Unable" with a reason.

**Conflicts (APREQ)**
- Math generates resolution candidates for **each** aircraft in the conflict (using `generateCandidates` with the goal "remove the conflict").
- The initiating agent proposes one candidate id for one aircraft, with a reason. The other agent approves or counter-proposes a different candidate id with a reason.
- Preferences: move the aircraft whose candidate has the smallest deviation; don't stop a departure's climb if a heading works; don't move the aircraft that's in the middle of a handoff.
- On agreement, store it with `addAgreement`.

**Point outs (receiving side)**
- Approve unless an aircraft in your sector would be within 3 NM and 1,000 ft of the projected path, or a directive forbids it. Reply "Point out approved" or "Unable" with the traffic.

**Directives**
- When the CIC addresses you in `#cic`, acknowledge in one line and store the directive. Follow active directives until they expire.

Add to MONITOR's instructions:
- When the same aircraft goes non-conforming twice in one session, say so ("Second non-conformance for this aircraft in five minutes").

---

## 8. New and changed Mastra tools

- `submit_review(...)`: section 6. Review path only.
- `add_agreement(...)` / `add_directive(...)`: write to the `Airspace` actor.
- `get_sector_picture(sector)`: now also returns active agreements and directives.
- `get_candidates(callsign, goal)`: wraps `generateCandidates`. `goal` is `"cic_request"`, `"resolve_conflict"`, or `"handoff_condition"`.
- `send_point_out(to, text)` / `reply_point_out(callsign, approved, reason?)`
- Keep `issue_clearance`, but only for handoff conditions and agreed APREQ plans. It still requires a passing probe.

---

## 9. Fallbacks (keep the demo reliable)

If the agent times out, returns invalid output, or picks an invalid candidate:
- Probe passed and no agreement or recent-clearance issue: **issue** with the standard phraseology.
- Otherwise: **unable**, using the first candidate (smallest deviation, no `breaks_agreement`), with reason "Automatic fallback: [probe reason]."
- Mark the `sectorReview` step `ok: false` with summary "Fallback used", so it's visible and honest.

Log every fallback to `#cic`.

---

## 10. Proposed API.md changes (additive, needs teammate agreement)

All changes add fields; nothing existing changes shape. Update `API.md` in the same commit once agreed.

- `ProbeResult.alternatives?: Candidate[]` (keep `alternative` as the one the AI chose).
- `POST /clearance` request: add `confirmed?: boolean`.
- `POST /clearance` response: add
  ```
  review?: {
    decision: "issue" | "unable" | "confirm" | "coordinate",
    by: "NORTH" | "SOUTH" | "FALLBACK",
    reason: string,
    question?: string,
    pointOut?: { to: "NORTH" | "SOUTH", result: "approved" | "unable" | "no_response" }
  }
  ```
- New response case: `{ issued: false, needsConfirm: true, question, review }`. UI shows the question with **Confirm** (resend with `confirmed: true`) and **Cancel**.
- `WorkflowStepName` adds `"context"` and `"coordinate"`. The UI should render any unknown step name generically.
- `AirspaceState` adds `agreements: Agreement[]` and `directives: Directive[]`.
- `422 Say again` details add `options?: string[]` (the spoken alternatives).

UI changes for the teammate:
- Show `review.reason` under the Unable card as **"Why this option"**. This is where judges see the AI's judgment.
- Confirm/Cancel card for `needsConfirm`.
- Small "Agreements" list (callsign, constraint, who agreed, time left) and "Directives" list in the left panel.
- Point out results appear in the feed already; no extra work.

---

## 11. Build order and time

Fit this into Phase 3, after basic handoffs and APREQs work. Do the items in this order and stop wherever time runs out:

1. Candidates (3a) + `submit_review` + validation + fallbacks (sections 6 and 9). **This alone fixes the "if-statement" problem.** About 30 minutes.
2. Flight phase (3b) + candidate preferences in the prompt. About 10 minutes.
3. Agreements (3c, 4) from APREQs + the agreement check in reviews. About 25 minutes.
4. Recent conflicting clearance (3d) + `confirm` + API confirm flow. About 15 minutes.
5. Point outs (3e) + the coordinate step. About 20 minutes.
6. Directives. About 15 minutes.
7. Better "say again" (5a). About 10 minutes.

Write tests for 3a to 3e before wiring the agents.

---

## 12. Demo beats this adds

Add to `CLAUDE.md` section 15 after the "Unable" beat:

- **The AI picks the smart option:** clear a departure into traffic. The controller replies "Unable… suggest turn right heading zero nine zero," and the card shows **"Why this option: keeps the departure climbing instead of stopping it at five thousand."**
- **The AI remembers:** right after an APREQ where NORTH and SOUTH agreed "Delta four fifty-six maintain six thousand," say "Delta four fifty-six, climb and maintain eight thousand." The controller replies "Unable, Delta four fifty-six is restricted at six thousand per coordination with NORTH." The math alone couldn't know that; it came from a conversation between agents over Relay, stored in the actor.
- **The AI coordinates:** clear an aircraft that will cross the line. Watch the point out go to the other sector and come back "approved" before the clearance is issued.
