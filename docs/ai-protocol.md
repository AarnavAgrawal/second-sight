# AI review protocol (internal contract for ai-updates.md)

How the clearance workflow (bridge, `mastra/src/workflows/clearance.ts`, Relay identity `CIC`), the sector agents (`agents/src/index.ts` + `mastra/src/tools`), and the `Airspace` actor talk. Types are in `shared/types.ts`. All Relay payloads go in message `data`.

## Safety rule
Agents choose **candidate ids** from math-generated candidates (`shared/candidates.ts` `generateCandidates`). They never supply numbers for a clearance. Tools validate ids against the candidates known in the current turn and re-probe before acting. The workflow re-validates every review and falls back deterministically.

## Clearance review (CIC request)
1. Workflow → sector DM (from `CIC`):
   `{ type: "CLEARANCE_REVIEW", requestId, session, hex, callsign, request: ClearanceRequest, requestedPhraseology, facts: ReviewFacts }`
   Text: `Review: <requestedPhraseology>` plus a one-line summary.
2. Sector agent turn: tools available include `submit_review` (must be called exactly once). The tool validates (same rules as the workflow, section "Validation") and returns `ok:false` with the reason if invalid so the agent can fix it in the same turn. Candidate ids refer to `facts.candidates`.
3. Sector → CIC DM: text = review.phraseology (spoken to the CIC), data
   `{ type: "REVIEW", requestId, session, from: <sector>, review: SectorReview | null }`
   The runner ALWAYS sends this after the turn (review `null` if the agent never submitted a valid review, so the workflow falls back immediately instead of timing out).
4. If `review.decision === "coordinate"` (validated): the sector runner also DMs the other sector:
   text = review.coordinationMessage, data `{ type: "POINT_OUT", requestId, session, from, hex, callsign, request, entry: SectorEntry }`.
5. Receiving sector agent: tool `reply_point_out({ approved, reason? })` → DM back to the originating sector:
   `{ type: "POINT_OUT_REPLY", requestId, session, from, approved: boolean, reason?: string }`, text "Point out approved." or "Unable, <traffic>.".
   The workflow watches the whole workspace (`watchAll`) for this reply (timeout `POINT_OUT_TIMEOUT_MS`, default 8000).
6. The workflow issues (via `mastra/src/ops.ts` `issueClearance`) or not, and returns the HTTP result.

### Validation (workflow and `submit_review` tool)
- `issue`: requested probe passed AND no broken agreement (unless `facts.confirmed`) AND no recent conflict (unless `facts.confirmed`) AND not entering the other sector (entering the other sector requires `coordinate`).
- `unable`: if `facts.candidates.length > 0`, `chosenCandidateId` must be one of them (and must not carry a `breaks_agreement:*` tag if a candidate without it exists).
- `coordinate`: only when `facts.sectorEntry.entersOther` or a broken agreement involves the other sector; requires `coordinationMessage`; the requested probe must pass.
- `confirm`: only when `facts.recentConflict` or `facts.brokenAgreements.length > 0`, and not already `facts.confirmed`; requires `question`.

### Fallback (invalid/missing review or timeout)
- Probe passed, no broken agreement, no recent conflict, not entering the other sector → issue with the standard phraseology.
- Otherwise → unable with the first candidate that has no `breaks_agreement:*` tag; reason `Automatic fallback: <probe reason>`.
- `sectorReview` step status `fail`, detail `Fallback used`. Post the fallback to `#cic` (from `CIC`).

### Confirm
`decision: "confirm"` → HTTP `{ issued: false, needsConfirm: true, question, review }`. The UI resends the same request with `confirmed: true`. With `confirmed`, the recent conflict is acknowledged and broken agreements are treated as cancelled by the CIC: if the request is then issued, the workflow calls `Airspace.expireAgreement(id, "cancelled by CIC")` for each and posts that to `#coord`.

## Agreements and directives (Airspace actor)
- `Airspace.addAgreement({ hex, callsign, constraint, between, source, text, expiresInSec? })` → `{ ok, agreement }` (default 300 s).
- `Airspace.expireAgreement(id, reason?)`, `Airspace.addDirective({ target, text, rule?, expiresInSec? })`, `Airspace.expireDirective(id)`.
- `Airspace.logClearance(entry: Omit<ClearanceLogEntry,"ts">)` (called by `ops.issueClearance`), emitted as `clearanceLog` (last 20).
- Emitted: `agreements` (active + last 10 expired/cancelled), `directives` (active + last 10 expired).

## APREQ with candidates
- Initiator: `get_candidates({ callsign, goal: "resolve_conflict", conflictId })` for each aircraft; picks one id; `send_dm(kind "APREQ", conflictId, candidateId)`. The tool attaches the full candidate in data: `{ type: "APREQ", conflictId, callsign, hex, candidate: Candidate, reason }`.
- Receiver: the runner seeds the turn's known candidates with `data.candidate`. Approve: `send_dm(kind "APREQ_REPLY", approved true, candidateId)` then `update_conflict(resolved)` and `add_agreement({ candidateId, source: "APREQ" })`. Counter: `send_dm(kind "APREQ_REPLY", approved false, candidateId: <own pick>)` (data carries that candidate).
- `add_agreement({ candidateId, source, note? })` builds the constraint from the candidate (altitude → maintain value; heading → maintain heading) and the text.

## Handoff with a condition
`check_handoff_entry` returns the entry-point traffic, `directiveBlocks` (an active `no_handoffs` directive for this sector), and `conditionCandidates` (`generateCandidates` goal `handoff_condition`). `accept_handoff({ callsign, conditionCandidateId? })`: transfers track control; with a condition it issues that candidate (probe must pass) and adds an agreement (source `handoff`). Reply text "<callsign>, radar contact, <condition>".

## Directives
CIC posts in `#cic`. The addressed agent (or NORTH for "all sectors") calls `add_directive({ target, text, rule?, expiresInSec? })` and acknowledges in one line. Agents receive active directives in every prompt (from `get_sector_picture` / the facts packet).
