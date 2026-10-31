// Agent runner: one process per identity (bun run agent NORTH | SOUTH | MONITOR).
// Connects a Mastra agent to Agent Relay. Routing (which events need a turn) is deterministic code;
// each turn gets the event, its structured payload, math-generated candidates (picked by id), and the
// agreements and CIC directives stored in the Airspace actor. Protocol: docs/ai-protocol.md.
import { createMonitorAgent, createSectorAgent } from "../../mastra/src/agents/controllers.ts";
import { issueClearance, probeFor } from "../../mastra/src/ops.ts";
import {
  candidatesFor,
  candidateLine,
  phaseOf,
  pointOutPrecheck,
  putCandidate,
  seedCandidates,
  type CandidateMap,
  type CandidateRef,
} from "../../mastra/src/tools/facts.ts";
import { allowedDecisions } from "../../mastra/src/tools/review.ts";
import { turn, type Identity, type TurnContext } from "../../mastra/src/tools/index.ts";
import { findAircraft, getView, liveAgreements, liveDirectives, type AirspaceView } from "../../mastra/src/view.ts";
import { aircraft, airspace } from "../../shared/adapters/actors.ts";
import { Relay, type RelayMessage } from "../../shared/adapters/relay.ts";
import { formatAltitude } from "../../shared/conformance.ts";
import { distToBoundaryNm } from "../../shared/geo.ts";
import { apreqPhrase, clearanceBody, handoffPhrase, spokenAltitude, spokenHeading, unablePhrase } from "../../shared/phraseology.ts";
import { numberWords, spokenCallsign } from "../../shared/telephony.ts";
import type { Candidate, ClearanceRequest, ProbeResult, ReviewFacts, Sector, SectorEntry, TrafficEntry } from "../../shared/types.ts";

const me = (process.argv[2] || "").toUpperCase() as Identity;
if (!["NORTH", "SOUTH", "MONITOR"].includes(me)) {
  console.error("Usage: bun run agent NORTH | SOUTH | MONITOR");
  process.exit(1);
}
const other: Sector | null = me === "NORTH" ? "SOUTH" : me === "SOUTH" ? "NORTH" : null;
const MAX_STEPS = 5; // 4 tool rounds + final answer
const REVIEW_STEPS = 4; // submit_review, a possible corrected retry, final answer
const STALE_MS = 60_000;
/** The workflow waits ~8 s for a REVIEW and ~8 s for a point out reply; past this a turn is pointless. */
const REVIEW_MAX_AGE_MS = 15_000;

const relay = await Relay.connect(me, {
  type: "agent",
  persona: me === "MONITOR" ? "Conformance monitoring agent." : `${me} sector controller agent.`,
});
const agent = me === "MONITOR" ? createMonitorAgent() : createSectorAgent(me as Sector);
let session = (await airspace().getAirport()).session;
console.log(`[${me}] connected to Relay; session ${session}; model ready`);

interface Job {
  key: string;
  msg: RelayMessage;
  type: string;
  priority: number;
  enqueuedAt: number;
  task: string;
  conflictId?: string;
  requestId?: string;
  maxSteps?: number;
  maxAgeMs?: number;
  /** Seed the turn context (known candidates, review facts, point out). */
  setup?: (ctx: TurnContext) => void;
  /** Runs after the turn (guaranteed replies). */
  after?: (ctx: TurnContext, text: string) => Promise<void>;
}
const queue: Job[] = [];
const seen = new Map<string, number>();
const history: RelayMessage[] = [];
const apreqRounds = new Map<string, number>();
/** MONITOR: NONCONF timestamps per hex this session. */
const nonconfHistory = new Map<string, number[]>();

type Data = Record<string, any>;
const dataOf = (m: RelayMessage): Data => (m.data ?? {}) as Data;
const sp = (cs: string) => spokenCallsign(cs);
const once = (key: string) => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
};
const remember = (m: RelayMessage) => {
  history.push(m);
  if (history.length > 60) history.shift();
};
const reqOf = (c: Candidate): ClearanceRequest => ({ kind: c.kind, value: c.value, ...(c.turn ? { turn: c.turn } : {}) });
/** "7,800 ft" / "FL230" / "altitude unknown" */
const altText = (ft: number | null) => (ft == null ? "altitude unknown" : ft >= 17950 ? formatAltitude(ft) : `${formatAltitude(ft)} ft`);
/** "to eight thousand" / "left heading two seven zero" (as in "Unable, <callsign> <what>"). */
const whatText = (r: ClearanceRequest) =>
  r.kind === "altitude" ? `to ${spokenAltitude(r.value)}` : `${r.turn ? `${r.turn} ` : ""}heading ${spokenHeading(r.value)}`;
const reqText = (cs: string, r: ClearanceRequest, altFt: number | null) => `${sp(cs)}, ${clearanceBody(r, altFt)}`;

function relatedMessages(terms: string[], exceptId: string): string {
  const t = terms.filter(Boolean).map((x) => x.toUpperCase());
  const rel = history.filter((m) => m.id !== exceptId && t.some((x) => m.text.toUpperCase().includes(x) || JSON.stringify(m.data ?? {}).toUpperCase().includes(x))).slice(-6);
  return rel.length ? rel.map((m) => `- ${m.from} -> ${m.to}: ${m.text}`).join("\n") : "(none)";
}

/** Active CIC directives for this sector, from the Airspace actor (not process memory). */
function directivesText(view: AirspaceView): string {
  const now = Date.now();
  const ds = liveDirectives(view, me === "MONITOR" ? undefined : me, now);
  return ds.length
    ? ds.map((d) => `- [${d.target}, ${Math.round((d.expiresAt - now) / 1000)} s left] "${d.text}"${d.rule ? ` (rule ${d.rule.type}${d.rule.value != null ? ` ${d.rule.value}` : ""})` : ""}`).join("\n")
    : "(none)";
}

function agreementsText(view: AirspaceView, hexes?: string[]): string {
  const now = Date.now();
  const ags = liveAgreements(view, undefined, now).filter((a) => !hexes || hexes.includes(a.hex));
  return ags.length ? ags.map((a) => `- ${a.text} (${a.source}, ${Math.round((a.expiresAt - now) / 1000)} s left)`).join("\n") : "(none)";
}

const minutesWords = (ms: number) => {
  const n = Math.max(1, Math.round(ms / 60_000));
  return n === 1 ? "one minute" : `${numberWords(n)} minutes`;
};

// ---------------- routing ----------------

async function route(m: RelayMessage): Promise<void> {
  remember(m);
  const d = dataOf(m);
  if (typeof d.session === "number" && d.session < session) return; // stale airport

  if (m.from === "RADAR" && d.type === "SESSION") {
    session = d.session ?? session + 1;
    queue.length = 0;
    apreqRounds.clear();
    nonconfHistory.clear();
    console.log(`[${me}] SESSION ${d.airport?.icao ?? ""}: dropped pending work`);
    return;
  }

  if (me === "MONITOR") {
    if (m.from === "RADAR" && d.type === "NONCONF" && once(`NONCONF:${d.hex}:${d.clearance?.issuedAt}`)) {
      const now = Date.now();
      const hist = [...(nonconfHistory.get(d.hex) ?? []), now];
      nonconfHistory.set(d.hex, hist);
      enqueue(m, 2, `NONCONF:${d.hex}`, "NONCONF", monitorTask(d, hist));
    }
    return;
  }

  // ---- sector controllers ----
  if (m.kind === "dm" && m.from === "CIC" && d.type === "CLEARANCE_REVIEW" && once(`REV:${d.requestId}`)) {
    return enqueueJob(await reviewJob(m, d));
  }
  if (m.kind === "dm" && m.from === "CIC" && d.type === "CLEARANCE_REQUEST" && once(`CLR:${d.requestId}`)) {
    // Pre-review workflow message: deterministic, no LLM turn.
    return void legacyClearance(d).catch((e) => console.error(`[${me}] legacy clearance failed:`, (e as Error).message));
  }
  if (m.from === "RADAR" && d.type === "BOUNDARY" && d.from === me && once(`BOUNDARY:${d.hex}:${d.from}:${d.attempt ?? 1}:${session}`)) {
    return enqueue(m, 1, `BOUNDARY:${d.hex}`, "BOUNDARY", await boundaryTask(d));
  }
  if (m.from === "RADAR" && d.type === "CA" && once(`CA:${d.id}`)) {
    const [sa, sb] = d.sectors as [Sector, Sector];
    if (sa !== sb && sa === me) return enqueueJob(await apreqInitJob(m, d));
    if (sa === sb && sa === me) return enqueueJob(await sameSectorJob(m, d));
    return;
  }
  if (m.kind === "dm" && m.from === other && once(`DM:${m.id}`)) {
    if (d.type === "POINT_OUT") return enqueueJob(await pointOutJob(m, d));
    if (d.type === "HANDOFF") return enqueue(m, 1, `HO:${m.id}`, "HANDOFF_IN", await handoffInTask(m, d));
    if (d.type === "APREQ" || (d.type === "APREQ_REPLY" && d.approved === false)) {
      const id = d.conflictId as string | undefined;
      const round = id ? (apreqRounds.get(id) ?? 0) + 1 : 1;
      if (id) apreqRounds.set(id, round);
      return enqueueJob(await apreqInJob(m, d, round));
    }
    if (d.type === "APREQ_REPLY" && d.approved === true) {
      // The approving sector usually posts the plan, resolves the CA and stores the agreement; only take a turn if it didn't.
      const c = d.conflictId ? (await getView()).conflicts.find((x) => x.id === d.conflictId) : undefined;
      if (c && c.state === "resolved") {
        console.log(`[${me}] APREQ approved for ${c.id}; already resolved by ${m.from}, no turn needed`);
        return;
      }
      return enqueueJob(await apreqApprovedJob(m, d));
    }
    return; // RADAR_CONTACT, UNABLE (handoff), POINT_OUT_REPLY (workflow reads it), INFO, ACK: no turn needed
  }
  if (m.kind === "dm" && m.from === "MONITOR" && d.type === "NONCONF" && once(`NC:${m.id}`)) {
    return enqueue(m, 2, `NC:${m.id}`, "NONCONF_DM", nonconfDmTask(m, d));
  }
  if (m.from === "CIC" && m.to === "#cic" && d.type !== "OVERRIDE" && once(`CIC:${m.id}`)) {
    const job = await cicJob(m);
    if (job) enqueueJob(job);
    return;
  }
}

function enqueue(m: RelayMessage, priority: number, key: string, type: string, task: string, extra: Partial<Job> = {}) {
  enqueueJob({ key, msg: m, type, priority, enqueuedAt: Date.now(), task, ...extra });
}

function enqueueJob(job: Job) {
  queue.push(job);
  queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
  void work();
}

const job = (m: RelayMessage, priority: number, key: string, type: string, task: string, extra: Partial<Job> = {}): Job => ({
  key,
  msg: m,
  type,
  priority,
  enqueuedAt: Date.now(),
  task,
  ...extra,
});

// ---------------- clearance review (CIC request) ----------------

function reviewFactsText(d: Data, facts: ReviewFacts, view: AirspaceView): string {
  const cs = d.callsign as string;
  const now = Date.now();
  const probe = facts.probe;
  const recent = facts.recentConflict;
  const entry = facts.sectorEntry;
  const lines = [
    `- Estimated phase: ${facts.phase}`,
    `- Probe of the request: ${probe.ok ? "PASSED (no loss of separation in 120 s, valid values)" : `FAILED: ${probe.reasons.join(" ")}`}`,
    `- Broken agreements: ${facts.brokenAgreements.length ? facts.brokenAgreements.map((a) => `"${a.text}" (${a.source}, ${Math.round((a.expiresAt - now) / 1000)} s left)`).join("; ") : "none"}`,
    `- Recent conflicting clearance: ${recent ? `"${recent.clearance.phraseology}" issued ${Math.round(recent.secondsAgo)} s ago by ${recent.clearance.issuedBy}; ${recent.why}` : "none"}`,
    `- Sector entry: ${entry.entersOther ? `enters ${entry.sector ?? other} in about ${entry.inSec != null ? Math.round(entry.inSec) : "?"} s` : "stays in your sector for 120 s"}`,
    `- Active CIC directives for you: ${facts.directives.length ? facts.directives.map((x) => `"${x.text}"${x.rule ? ` (rule ${x.rule.type}${x.rule.value != null ? ` ${x.rule.value}` : ""})` : ""}`).join("; ") : "none"}`,
    `- CIC confirmed this request: ${facts.confirmed ? "YES (recent clearance acknowledged; broken agreements are cancelled by the CIC)" : "no"}`,
  ];
  const t = findAircraft(view, cs);
  if (t && view.airport) {
    lines.push(`- Aircraft now: ${altText(t.altFt)}, ${Math.round(t.vertRateFpm)} fpm, ${Math.round(distToBoundaryNm(t.lat, view.airport) * 10) / 10} NM from the sector line`);
  }
  return lines.join("\n");
}

/** Suggested point out text built from math facts (numbers never come from the model). */
function pointOutText(cs: string, req: ClearanceRequest, entry: SectorEntry, view: AirspaceView): string {
  const t = findAircraft(view, cs);
  const parts = [`Point out, ${sp(cs)}`];
  if (t && view.airport) {
    const nm = Math.round(distToBoundaryNm(t.lat, view.airport));
    const side = t.lat >= view.airport.lat ? "north" : "south";
    parts.push(nm < 1 ? `less than one mile ${side} of the line` : `${nm === 1 ? "one mile" : `${numberWords(nm)} miles`} ${side} of the line`);
    if (t.altFt != null) parts.push(spokenAltitude(t.altFt));
  }
  parts.push(clearanceBody(req, t?.altFt ?? null));
  if (entry.inSec != null) parts.push(`will enter your airspace in about ${numberWords(Math.max(10, Math.round(entry.inSec / 10) * 10))} seconds`);
  return `${parts.join(", ")}.`;
}

async function reviewJob(m: RelayMessage, d: Data): Promise<Job> {
  const facts = d.facts as ReviewFacts;
  const cs = d.callsign as string;
  const req = d.request as ClearanceRequest;
  const view = await getView();
  const allowed = allowedDecisions(facts);
  const recent = facts.recentConflict;
  const candLines = facts.candidates.length ? facts.candidates.map((c) => candidateLine(c.id, c)).join("\n") : "(none: no safe alternative found)";
  const task = `CLEARANCE REVIEW ${d.requestId}. The CIC requests: "${d.requestedPhraseology}" for ${cs} (${sp(cs)}), under your track control.
Facts (computed by math; never compute or invent numbers):
${reviewFactsText(d, facts, view)}
Candidates (each already passes the probe; pick only by id):
${candLines}
Allowed decisions for these facts: ${allowed.join(", ")}.

Decision guide:
- issue: safe, breaks no agreement, no recent contradiction, stays in your sector. phraseology exactly "${d.requestedPhraseology}".
- unable: unsafe, breaks an agreement, or a CIC directive forbids it. Pick the BEST candidate, preferences in order: (1) no breaks_agreement tag; (2) no enters_other_sector_120s unless nothing else; (3) departure: prefer keeps_climb, avoid stopping a departure's climb low; (4) arrival: prefer altitude changes over large turns, and toward_airport; (5) overflight: smallest deviation; (6) avoid large_deviation when a smaller safe option exists. phraseology like "Unable, ${sp(cs)} ${whatText(req)}, <the deciding fact>. Suggest <the chosen candidate's clearance>."
- coordinate: safe but enters the other sector. coordinationMessage exactly: "${pointOutText(cs, req, facts.sectorEntry, view)}" phraseology: "${sp(cs)}, pointing out to ${other}, stand by."
- confirm: a recent conflicting clearance, or an agreement the CIC may not know about. question like ${recent ? `"Confirm, ${sp(cs)} was cleared ${whatText(recent.clearance)} ${Math.round(recent.secondsAgo)} seconds ago?"` : `"Confirm, ${sp(cs)} is restricted by coordination with ${other}: <agreement>. Cancel the restriction?"`} phraseology = the question.
- reason: one or two sentences naming the deciding facts, e.g. "Keeps the departure climbing and stays out of ${other}'s airspace."
Task: call submit_review exactly once. If it returns ok:false, fix the problem and call it again. Do not call any other action tools. Then stop.`;
  return job(m, 0, `REV:${d.requestId}`, "CLEARANCE_REVIEW", task, {
    requestId: d.requestId,
    maxSteps: REVIEW_STEPS,
    maxAgeMs: REVIEW_MAX_AGE_MS,
    setup: (ctx) => {
      ctx.reviewFacts = facts;
      ctx.request = { hex: d.hex, callsign: cs, request: req };
      for (const c of facts.candidates) ctx.candidates.set(c.id, { ...c, callsign: cs, hex: d.hex });
    },
    after: async (ctx) => {
      const review = ctx.review;
      const base = { requestId: d.requestId, session, from: me };
      const r = await relay.dm("CIC", review?.phraseology || "Automatic fallback.", { type: "REVIEW", ...base, review: review ?? null });
      remember(r);
      if (review?.decision === "coordinate" && other) {
        const po = await relay.dm(other, review.coordinationMessage!, { type: "POINT_OUT", ...base, hex: d.hex, callsign: cs, request: req, entry: facts.sectorEntry });
        remember(po);
      }
    },
  });
}

/** Old workflow message (CLEARANCE_REQUEST): the probe decides, no LLM. Kept until every workflow sends CLEARANCE_REVIEW. */
async function legacyClearance(d: Data) {
  const req = d.clearance as ClearanceRequest;
  const probe = d.probe as ProbeResult;
  let issued: { phraseology: string } | null = null;
  if (probe?.ok) {
    const r = await issueClearance({ callsign: d.callsign, req, issuedBy: me });
    if (r.ok) issued = { phraseology: r.phraseology };
  }
  const text = issued ? issued.phraseology : unablePhrase(d.callsign, req, probe);
  await relay.post("cic", text, { type: "CLEARANCE_REPLY", from: me, session, requestId: d.requestId, issued: !!issued, phraseology: issued?.phraseology ?? null, callsign: d.callsign });
}

// ---------------- point out (receiving side) ----------------

async function pointOutJob(m: RelayMessage, d: Data): Promise<Job> {
  const view = await getView();
  const cs = (d.callsign as string) || "";
  const req = (d.request as ClearanceRequest | undefined) ?? null;
  const entry = (d.entry as SectorEntry | undefined) ?? { entersOther: true };
  const pre = pointOutPrecheck(view, me as Sector, d.hex, req);
  const trafficLines = pre.traffic.length
    ? pre.traffic.map((t) => `- ${t.callsign} (${sp(t.callsign)}): ${t.minLatNm} NM / ${t.minVertFt} ft, first loss in ${t.inSec} s`).join("\n")
    : "(none)";
  const deterministicReason = pre.traffic[0]
    ? `traffic ${sp(pre.traffic[0].callsign)}, ${pre.traffic[0].minLatNm} miles, ${pre.traffic[0].minVertFt} feet`
    : pre.blocking[0] ?? "";
  const task = `${m.from} points out ${cs} (${sp(cs)}): "${m.text}"
Requested clearance: ${req ? reqText(cs, req, findAircraft(view, cs)?.altFt ?? null) : "(not given)"}; enters your airspace in about ${entry.inSec != null ? Math.round(entry.inSec) : "?"} s.
Pre-check (math): your aircraft within 3 NM and 1,000 ft of its cleared path in the next 120 s:
${trafficLines}
CIC directives that forbid it: ${pre.blocking.length ? pre.blocking.join("; ") : "none"}
Active CIC directives for you: ${pre.directives.length ? pre.directives.join("; ") : "none"}
Task: call reply_point_out exactly once. Approve unless the pre-check lists traffic or a forbidding directive. If unable, the reason names the traffic in words (e.g. "${deterministicReason || "traffic Delta four fifty-six, 1.2 miles, 400 feet"}") or the directive. Then stop.`;
  return job(m, 0, `PO:${m.id}`, "POINT_OUT", task, {
    requestId: d.requestId,
    maxSteps: 3,
    maxAgeMs: REVIEW_MAX_AGE_MS,
    setup: (ctx) => {
      ctx.requestId = d.requestId;
      ctx.pointOut = { requestId: d.requestId, from: m.from as Sector, callsign: cs, replied: false };
    },
    after: async (ctx) => {
      if (ctx.pointOut?.replied) return;
      // The agent never answered: reply deterministically from the pre-check so the workflow never waits.
      const approved = pre.clear;
      const text = approved ? "Point out approved." : `Unable, ${deterministicReason}.`;
      const r = await relay.dm(m.from, text, {
        type: "POINT_OUT_REPLY",
        requestId: d.requestId,
        session,
        from: me,
        callsign: cs,
        approved,
        ...(approved ? {} : { reason: deterministicReason }),
        fallback: true,
      });
      remember(r);
    },
  });
}

// ---------------- handoffs ----------------

async function boundaryTask(d: Data): Promise<string> {
  let target: number | null = null;
  try {
    const st = await aircraft(d.hex).getState();
    if (st.clearance?.kind === "altitude") target = st.clearance.value;
  } catch {
    /* no aircraft actor */
  }
  const phrase = handoffPhrase(d.callsign, d.altFt, d.vertRateFpm, target, d.distNm, d.side);
  return `RADAR: ${d.callsign} (${sp(d.callsign)}), under your track control, will cross into ${d.to} in about 90 s (${d.distNm} NM from the line, ${d.side} side, ${formatAltitude(d.altFt)}).
Task: call initiate_handoff for ${d.callsign}. If it succeeds, send_dm to ${d.to} with kind "HANDOFF", callsign "${d.callsign}", text exactly: "${phrase}". If it fails, stop.`;
}

async function handoffInTask(m: RelayMessage, d: Data): Promise<string> {
  const cs = (d.callsign as string) || "";
  const s = cs ? sp(cs) : "<spoken callsign>";
  const view = await getView();
  return `${m.from} DMs you a handoff: "${m.text}" (callsign ${cs || "see text"}).
Active CIC directives for you:
${directivesText(view)}
Task: call check_handoff_entry for the aircraft, then exactly one outcome:
a) directiveBlocks is not empty: reject_handoff citing the directive, then send_dm to ${m.from} kind "UNABLE" text "Unable ${s}, <the CIC directive in a few words>."
b) traffic near the entry point: if a conditionCandidate fixes it, accept_handoff with conditionCandidateId, then send_dm to ${m.from} kind "RADAR_CONTACT" text "${s}, radar contact, <the condition clearance>." Otherwise reject_handoff with the traffic, then send_dm kind "UNABLE" text "Unable ${s}, traffic <spoken callsign>, <numbers from the tool>. Suggest <a conditionCandidate clearance, if any>."
c) clear: accept_handoff (no condition), then send_dm to ${m.from} kind "RADAR_CONTACT" text "${s}, radar contact."
Only attach a condition when traffic or an agreement makes one useful.`;
}

// ---------------- conflicts (APREQ) ----------------

interface ConflictSide {
  t: TrafficEntry;
  owner: Sector | null;
  phase: string | null;
  inHandoff: boolean;
  lines: string[];
}

/** Candidates for one aircraft in a conflict, seeded into `seed` and rendered with ready APREQ text. */
function conflictSide(view: AirspaceView, t: TrafficEntry, trafficCs: string, seed: CandidateMap): ConflictSide {
  const list = candidatesFor(view, t, "resolve_conflict", null, { max: 4 });
  const lines = seedCandidates(seed, list).map(
    ({ key, c }) => `${candidateLine(key, c)} -> APREQ text "${apreqPhrase(t.callsign, reqOf(c), trafficCs, t.altFt)}"`,
  );
  return {
    t,
    owner: view.trackControl[t.hex] ?? null,
    phase: phaseOf(view, t),
    inHandoff: view.handoffs.some((h) => h.hex === t.hex && (h.state === "pending" || h.state === "overdue")),
    lines,
  };
}

function sideText(s: ConflictSide): string {
  return `${s.t.callsign} (${sp(s.t.callsign)}): owner ${s.owner ?? "none"}, estimated phase ${s.phase ?? "unknown"}, ${altText(s.t.altFt)}, ${Math.round(s.t.vertRateFpm)} fpm${s.inHandoff ? ", IN A PENDING HANDOFF (do not move it)" : ""}
${s.lines.length ? s.lines.join("\n") : "  (no probe-clean candidate)"}`;
}

function conflictSides(view: AirspaceView, a: string, b: string, hexA: string | undefined, hexB: string | undefined, seed: CandidateMap) {
  const ta = (hexA && view.traffic.find((x) => x.hex === hexA)) || findAircraft(view, a);
  const tb = (hexB && view.traffic.find((x) => x.hex === hexB)) || findAircraft(view, b);
  return [ta ? conflictSide(view, ta, b, seed) : null, tb ? conflictSide(view, tb, a, seed) : null].filter((x): x is ConflictSide => !!x);
}

const APREQ_PREFS = `Preferences: move the aircraft whose best candidate has the smallest deviation; don't stop a departure's climb (stops_climb) if a heading works; don't move an aircraft in a pending handoff; avoid breaks_agreement and large_deviation tags.`;

async function apreqInitJob(m: RelayMessage, d: Data): Promise<Job> {
  const [ac0, ac1] = d.aircraft as Data[];
  const view = await getView();
  const seed: CandidateMap = new Map();
  const sides = conflictSides(view, d.a, d.b, d.hexA, d.hexB, seed);
  const task = `RADAR conflict alert ${d.id}: ${d.a} (${sp(d.a)}, your sector, ${formatAltitude(ac0!.altFt)}, ${ac0!.vertRateFpm} fpm, track ${ac0!.magTrackDeg}) and ${d.b} (${sp(d.b)}, ${other}'s sector, ${formatAltitude(ac1!.altFt)}, ${ac1!.vertRateFpm} fpm, track ${ac1!.magTrackDeg}). Predicted ${d.predictedLatNm} NM / ${d.predictedVertFt} ft in ${d.inSec} s. Cross-sector; you control ${d.a}, so you start the APREQ.
Math-generated resolution candidates (each passes the probe and removes the conflict; pick by id):
${sides.map(sideText).join("\n")}
Agreements on these aircraft:
${agreementsText(view, sides.map((s) => s.t.hex))}
${APREQ_PREFS}
Task: pick ONE candidate id. send_dm to ${other} with kind "APREQ", conflictId "${d.id}", candidateId <id>, reason <the deciding facts in one sentence>, text = that candidate's APREQ text. Then update_conflict ${d.id} "coordinating". If there are no candidates at all: update_conflict ${d.id} "escalated" and post to cic "Unable to resolve CA ${d.a}/${d.b}, CIC action required."`;
  return job(m, 1, `CA:${d.id}`, "CA_CROSS", task, { conflictId: d.id, setup: (ctx) => copyInto(ctx.candidates, seed) });
}

function copyInto(target: CandidateMap, src: CandidateMap) {
  for (const [k, v] of src) target.set(k, v);
}

async function apreqInJob(m: RelayMessage, d: Data, round: number): Promise<Job> {
  const id = d.conflictId as string;
  const view = await getView();
  const c = view.conflicts.find((x) => x.id === id);
  const seed: CandidateMap = new Map();
  // The other sector's proposal (or counter-proposal) first, so it keeps its own key.
  let proposedKey: string | undefined;
  let proposalFact = "(no candidate attached; read the text)";
  const inc = d.candidate as CandidateRef | undefined;
  if (inc && inc.callsign && inc.hex) {
    proposedKey = putCandidate(seed, `${inc.callsign}:${inc.id}`, inc);
    const pr = await probeFor(inc.callsign, reqOf(inc), view);
    const t = findAircraft(view, inc.callsign);
    const pending = t ? view.handoffs.some((h) => h.hex === t.hex && (h.state === "pending" || h.state === "overdue")) : false;
    proposalFact = `${candidateLine(proposedKey, inc)}
  Re-probe now: ${pr.ok ? (pr.probe.ok ? "CLEAN" : `FAILS: ${pr.probe.reasons.join(" ")}`) : pr.error}. Owner: ${t ? (view.trackControl[t.hex] ?? "none") : "?"}${t ? `, estimated phase ${phaseOf(view, t)}` : ""}${pending ? ", IN A PENDING HANDOFF" : ""}.${d.reason ? ` Their reason: "${d.reason}"` : ""}`;
  }
  const sides = c ? conflictSides(view, c.a, c.b, c.hexA, c.hexB, seed) : [];
  const last = round >= 2;
  const pk = proposedKey ?? "<their candidate id>";
  const task = `${m.from} DMs you (${d.type === "APREQ" ? "APREQ" : "Unable with a counter-proposal"}, round ${round} of 2) about conflict ${id}${c ? ` (${c.a}/${c.b}, state ${c.state})` : ""}: "${m.text}"
Their proposal:
${proposalFact}
Recent coordination:
${relatedMessages([id, c?.a ?? "", c?.b ?? ""], m.id)}
Other math-generated candidates (for a counter-proposal; pick by id):
${sides.length ? sides.map(sideText).join("\n") : "(conflict not found)"}
Agreements on these aircraft:
${agreementsText(view, sides.map((s) => s.t.hex))}
${APREQ_PREFS}
Task: approve their proposal if its re-probe is CLEAN and it fits the preferences reasonably; otherwise counter.
- Approve: send_dm to ${m.from} kind "APREQ_REPLY", approved true, conflictId "${id}", candidateId "${pk}", text "<spoken callsign>, <clearance>, approved." Then post to coord one line "Plan for CA ${c?.a ?? ""}/${c?.b ?? ""}: <spoken callsign> <clearance>. Coordinated ${me}/${m.from}.", update_conflict ${id} "resolved" with that plan as resolution, and add_agreement candidateId "${pk}" source "APREQ" note "for traffic <other callsign>".
- ${last ? `This is the last round: if you cannot approve, update_conflict ${id} "escalated" and post to cic "CA ${c?.a ?? ""}/${c?.b ?? ""}: no agreement after two rounds. CIC action required."` : `Counter: send_dm to ${m.from} kind "APREQ_REPLY", approved false, conflictId "${id}", candidateId <a DIFFERENT candidate id>, reason <deciding facts>, text "Unable, <reason>. Suggest <that candidate's clearance>."`}`;
  return job(m, 1, `AP:${m.id}`, "APREQ_IN", task, {
    conflictId: id,
    setup: (ctx) => {
      copyInto(ctx.candidates, seed);
      if (proposedKey) ctx.proposedKey = proposedKey;
    },
  });
}

async function apreqApprovedJob(m: RelayMessage, d: Data): Promise<Job> {
  const id = d.conflictId as string;
  const view = await getView();
  const seed: CandidateMap = new Map();
  const inc = d.candidate as CandidateRef | undefined;
  let key: string | undefined;
  if (inc && inc.callsign && inc.hex) key = putCandidate(seed, `${inc.callsign}:${inc.id}`, inc);
  const stored = inc ? liveAgreements(view).some((a) => a.hex === inc.hex) : false;
  const task = `${m.from} approved the APREQ for conflict ${id}: "${m.text}"${key ? `\nApproved candidate: ${candidateLine(key, inc!)}` : ""}
Task: post to coord the agreed plan in one line ("Plan for CA ...: <spoken callsign> <clearance>. Coordinated ${me}/${m.from}.") and update_conflict ${id} "resolved" with that plan as resolution.${key && !stored ? ` Then add_agreement candidateId "${key}" source "APREQ".` : " The agreement is already stored."} If the conflict is already resolved, do nothing.`;
  return job(m, 1, `AP:${m.id}`, "APREQ_APPROVED", task, {
    conflictId: id,
    setup: (ctx) => {
      copyInto(ctx.candidates, seed);
      if (key) ctx.proposedKey = key;
    },
  });
}

async function sameSectorJob(m: RelayMessage, d: Data): Promise<Job> {
  const view = await getView();
  const seed: CandidateMap = new Map();
  const sides = conflictSides(view, d.a, d.b, d.hexA, d.hexB, seed);
  const task = `RADAR conflict alert ${d.id} inside your sector: ${d.a} (${sp(d.a)}) and ${d.b} (${sp(d.b)}), predicted ${d.predictedLatNm} NM / ${d.predictedVertFt} ft in ${d.inSec} s.
Math-generated resolution candidates (pick by id):
${sides.map(sideText).join("\n")}
${APREQ_PREFS}
Task: pick ONE candidate and post it to coord as an advisory to the CIC (kind "ADVISORY"): "CA ${d.a}/${d.b}: suggest <the candidate phraseology> for traffic <spoken other>." Then update_conflict ${d.id} "coordinating". Do not issue the clearance yourself. If there are no candidates, post the advisory "CA ${d.a}/${d.b}: no clean resolution found, CIC action required." and update_conflict ${d.id} "escalated".`;
  return job(m, 2, `CA:${d.id}`, "CA_SAME", task, { conflictId: d.id, setup: (ctx) => copyInto(ctx.candidates, seed) });
}

// ---------------- conformance, CIC ----------------

function nonconfDmTask(m: RelayMessage, d: Data): string {
  return `MONITOR reports non-conformance for an aircraft you control: "${m.text}" (callsign ${d.callsign ?? "see text"}).
Task: post ONE short line to alerts (kind "ADVISORY") with your action, e.g. "${d.callsign ? sp(d.callsign) : "<callsign>"}: non-conformance noted, verifying altitude, traffic advisory to adjacent sector if needed." Use only numbers from the message.`;
}

/** Who a #cic message addresses, from its words. */
function addressee(text: string): Sector | "ALL" {
  const n = /\bnorth\b/i.test(text);
  const s = /\bsouth\b/i.test(text);
  if (n && !s) return "NORTH";
  if (s && !n) return "SOUTH";
  return "ALL";
}

async function cicJob(m: RelayMessage): Promise<Job | null> {
  const addr = addressee(m.text);
  if (addr !== "ALL" && addr !== me) return null; // addressed to the other sector only
  const view = await getView();
  const stores = addr === me || me === "NORTH";
  const target = addr === "ALL" ? "ALL" : me;
  const task = `The CIC posted in #cic: "${m.text}" (addressed to ${addr === "ALL" ? "all sectors" : me}).
Active CIC directives:
${directivesText(view)}
Task:
- If it is a standing direction (e.g. "stop accepting handoffs for two minutes", an altitude cap or floor): ${
    stores
      ? `call add_directive with target "${target}", text = the CIC's exact words, rule if it maps (no_handoffs; altitude_cap / altitude_floor with value in feet from the CIC's words; else other), expiresInSec = the duration the CIC said (e.g. two minutes = 120; omit if none). Then post to cic (kind "ACK") one line, e.g. "${me}, wilco, <the direction in a few words>."`
      : `do NOT call add_directive (NORTH stores all-sector directives). Just post to cic (kind "ACK") one line, e.g. "${me}, wilco."`
  }
- If it is a question for you, answer in one line with post to cic, using get_sector_picture.
- If it needs nothing from you, do not call any tools and answer "no action".`;
  return job(m, 1, `CIC:${m.id}`, "CIC", task);
}

const ORDINAL = ["", "First", "Second", "Third", "Fourth", "Fifth"];

function monitorTask(d: Data, hist: number[]): string {
  const n = hist.length;
  const repeat =
    n >= 2
      ? `\nThis is non-conformance number ${n} for this aircraft this session (first one ${minutesWords(hist[n - 1]! - hist[0]!)} ago). Begin the first sentence with "${ORDINAL[n] ?? `Repeated`} non-conformance for this aircraft in ${minutesWords(hist[n - 1]! - hist[0]!)}."`
      : "";
  return `RADAR reports NONCONF: ${JSON.stringify({ callsign: d.callsign, cleared: d.clearedText, clearance: d.clearance, altFt: d.altFt, vertRateFpm: d.vertRateFpm, magTrackDeg: d.magTrackDeg, owner: d.owner, reason: d.reason })}${repeat}
Task: write exactly two plain-English sentences for the CIC explaining what the aircraft was cleared to do and what it is actually doing, using only these numbers (spoken callsign: ${sp(d.callsign)}). Post them to alerts (kind "NONCONF").${d.owner ? ` Then send_dm the same text to ${d.owner} with kind "NONCONF" and callsign "${d.callsign}".` : ""}`;
}

// ---------------- worker ----------------

let busy = false;
async function work() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const d = dataOf(job.msg);
      if (typeof d.session === "number" && d.session < session) continue;
      if (Date.now() - job.enqueuedAt > (job.maxAgeMs ?? STALE_MS)) {
        console.log(`[${me}] dropped stale ${job.key}`);
        continue;
      }
      await runTurn(job);
    }
  } finally {
    busy = false;
  }
}

async function runTurn(job: Job) {
  const ctx: TurnContext = {
    me,
    relay,
    session,
    eventId: job.msg.id,
    eventType: job.type,
    ...(job.requestId ? { requestId: job.requestId } : {}),
    ...(job.conflictId ? { conflictId: job.conflictId } : {}),
    issued: null,
    probes: [],
    sent: [],
    actions: [],
    candidates: new Map(),
    review: null,
  };
  job.setup?.(ctx);
  turn.ctx = ctx;
  const t0 = Date.now();
  const prompt = `Event from ${job.msg.from} to ${job.msg.to}: "${job.msg.text}"
${job.task}`;
  let text = "";
  try {
    const res = await agent.generate(prompt, { maxSteps: job.maxSteps ?? MAX_STEPS });
    text = (res.text || "").trim();
  } catch (e) {
    console.error(`[${me}] turn ${job.key} failed:`, (e as Error).message);
  } finally {
    turn.ctx = null;
  }
  for (const m of ctx.sent) remember(m);
  // Count our own APREQ messages toward the two-round limit.
  for (const m of ctx.sent) {
    const d = dataOf(m);
    if (d.conflictId && (d.type === "APREQ" || (d.type === "APREQ_REPLY" && d.approved === false))) {
      apreqRounds.set(d.conflictId, (apreqRounds.get(d.conflictId) ?? 0) + 1);
    }
  }
  if (job.after) {
    try {
      await job.after(ctx, text);
    } catch (e) {
      console.error(`[${me}] after-turn ${job.key} failed:`, (e as Error).message);
    }
  }
  console.log(`[${me}] ${job.type} ${job.key} (${Date.now() - t0} ms) actions=[${ctx.actions.join("; ")}] sent=${ctx.sent.length} ${text ? `final="${text.slice(0, 140)}"` : ""}`);
}

relay.onMessage((m) => route(m).catch((e) => console.error(`[${me}] route error:`, (e as Error).message)));
process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});
