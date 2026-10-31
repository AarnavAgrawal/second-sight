// Mastra tools for the sector controller and monitor agents. Thin wrappers over the actor client,
// shared/ logic, and the Relay adapter. Safety rules are enforced here in code, not by the model:
// agents pick math-generated candidate ids; tools validate ids and re-probe before acting.
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { airspace } from "../../../shared/adapters/actors.ts";
import type { Relay, RelayMessage } from "../../../shared/adapters/relay.ts";
import { agreementFromCandidate } from "../../../shared/agreements.ts";
import { haversineNm } from "../../../shared/geo.ts";
import { projectStraight } from "../../../shared/separation.ts";
import type { ClearanceRequest, ProbeResult, ReviewFacts, Sector, SectorReview } from "../../../shared/types.ts";
import { issueClearance, probeFor } from "../ops.ts";
import { findAircraft, getView, liveAgreements, liveDirectives, sectorPicture, toPosition } from "../view.ts";
import { candidatesFor, findCandidate, handoffBlocks, phaseOf, seedCandidates, type CandidateMap, type CandidateRef } from "./facts.ts";
import { validateReview } from "./review.ts";

export type Identity = "NORTH" | "SOUTH" | "MONITOR";
export type { CandidateMap, CandidateRef } from "./facts.ts";

/** Per-turn context set by the agent runner before each generate() call. */
export interface TurnContext {
  me: Identity;
  relay: Relay;
  session: number;
  eventId: string;
  eventType: string;
  requestId?: string;
  conflictId?: string;
  /** Set by issue_clearance / accept_handoff (with a condition) when a clearance is issued this turn. */
  issued: { callsign: string; phraseology: string } | null;
  /** Probe results seen this turn. */
  probes: { callsign: string; probe: ProbeResult; phraseology: string }[];
  sent: RelayMessage[];
  actions: string[];
  /** Candidates the agent may pick this turn. Review candidates keyed by their id ("c1"); others `${callsign}:${id}`. */
  candidates: CandidateMap;
  /** Set by submit_review once a review validates. */
  review: SectorReview | null;
  /** Present only in clearance review turns. */
  reviewFacts?: ReviewFacts;
  request?: { hex: string; callsign: string; request: ClearanceRequest };
  /** Present only in point-out turns (receiving side). */
  pointOut?: { requestId: string; from: Sector; callsign: string; replied: boolean };
  /** Key of the candidate the other sector proposed in this turn's APREQ / counter-proposal. */
  proposedKey?: string;
}

// Per-turn context. Several turns can run at once (clearance reviews and point outs run alongside the queue),
// so the context travels with each generate() call in Mastra's requestContext, and every tool execution is
// wrapped to make it the ambient context (AsyncLocalStorage) for the ctx() helper below.
const TURN_KEY = "secondSightTurn";
const ambient = new AsyncLocalStorage<TurnContext>();
export const turn = {
  /** Build the requestContext to pass to agent.generate(prompt, { requestContext }). */
  requestContext(c: TurnContext): RequestContext {
    const rc = new RequestContext();
    rc.set(TURN_KEY, c);
    return rc;
  },
  get ctx(): TurnContext | null {
    return ambient.getStore() ?? null;
  },
};
const ctx = () => {
  const c = ambient.getStore();
  if (!c) throw new Error("No active turn.");
  return c;
};

/** Make each tool run with its call's TurnContext as the ambient context. */
function bindTurn<T extends Record<string, unknown>>(tools: T): T {
  for (const tool of Object.values(tools) as { execute?: (input: unknown, context: unknown) => Promise<unknown> }[]) {
    const original = tool.execute;
    if (!original || (original as { __bound?: boolean }).__bound) continue;
    const bound = (input: unknown, context: unknown) => {
      const rc = (context as { requestContext?: { get(k: string): unknown } } | undefined)?.requestContext;
      const c = (rc?.get?.(TURN_KEY) as TurnContext | undefined) ?? ambient.getStore();
      return c ? ambient.run(c, () => original.call(tool, input, context)) : original.call(tool, input, context);
    };
    (bound as { __bound?: boolean }).__bound = true;
    tool.execute = bound;
  }
  return tools;
}

const SectorEnum = z.enum(["NORTH", "SOUTH"]);
const KindEnum = z.enum(["altitude", "heading"]);
const TurnEnum = z.enum(["left", "right"]);
const MsgKind = z.enum(["HANDOFF", "RADAR_CONTACT", "UNABLE", "APREQ", "APREQ_REPLY", "NONCONF", "ADVISORY", "ACK", "INFO"]);

const clearanceInput = z.object({
  callsign: z.string().describe("ICAO callsign, e.g. UAL123"),
  kind: KindEnum,
  value: z.number().int().describe("Altitude in feet (FL230 = 23000) or magnetic heading 1-360"),
  turn: TurnEnum.optional().describe("Turn direction for heading clearances"),
});

const meta = (extra: Record<string, unknown>) => {
  const c = ctx();
  return {
    from: c.me,
    session: c.session,
    inReplyTo: c.eventId,
    ...(c.requestId ? { requestId: c.requestId } : {}),
    ...(c.conflictId ? { conflictId: c.conflictId } : {}),
    ...extra,
  };
};

const reqOf = (c: CandidateRef): ClearanceRequest => ({ kind: c.kind, value: c.value, ...(c.turn ? { turn: c.turn } : {}) });
const otherOf = (s: Sector): Sector => (s === "NORTH" ? "SOUTH" : "NORTH");

/** Review turns only report a decision; the workflow acts on it. Side-effect tools are refused there. */
function refuseInReview(): { ok: false; error: string } | null {
  return ctx().reviewFacts ? { ok: false, error: "Clearance review turn: do not act directly. Call submit_review; the workflow acts on it." } : null;
}

function sectorOrError(): { sector: Sector } | { error: string } {
  const c = ctx();
  return c.me === "MONITOR" ? { error: "MONITOR has no track control." } : { sector: c.me };
}

export const getSectorPicture = createTool({
  id: "get_sector_picture",
  description:
    "Active airport, aircraft under this sector's track control (altitude, vertical rate, ground speed, magnetic track, status, NM from the sector boundary), pending handoffs, active conflict alerts, active agreements with the other sector, and active CIC directives.",
  inputSchema: z.object({ sector: SectorEnum.optional().describe("Defaults to your own sector") }),
  execute: async (input) => {
    const c = ctx();
    const sector = (input.sector ?? (c.me === "MONITOR" ? "NORTH" : c.me)) as Sector;
    return sectorPicture(await getView(), sector);
  },
});

export const probeClearanceTool = createTool({
  id: "probe_clearance",
  description: "Probe a proposed clearance for invalid values (simplified floor, FL450) and predicted loss of separation in the next 120 s. Read-only: it never issues anything.",
  inputSchema: clearanceInput,
  execute: async (input) => {
    const r = await probeFor(input.callsign, { kind: input.kind, value: input.value, ...(input.turn ? { turn: input.turn } : {}) });
    if (!r.ok) return r;
    ctx().probes.push({ callsign: r.callsign, probe: r.probe, phraseology: r.phraseology });
    return { ok: r.probe.ok, callsign: r.callsign, phraseology: r.phraseology, reasons: r.probe.reasons, conflicts: r.probe.conflicts };
  },
});

export const getCandidates = createTool({
  id: "get_candidates",
  description:
    "Math-generated, probe-clean clearance options for one aircraft (ids like UAL123:c1, phraseology, deviation, tags). goal: cic_request, resolve_conflict, or handoff_condition. Pick options only by id.",
  inputSchema: z.object({
    callsign: z.string(),
    goal: z.enum(["cic_request", "resolve_conflict", "handoff_condition"]),
    conflictId: z.string().optional().describe("For resolve_conflict: the CA id"),
  }),
  execute: async ({ callsign, goal, conflictId }) => {
    const c = ctx();
    const v = await getView();
    if (!v.airport) return { ok: false, error: "No active airport." };
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    let traffic: string | null = null;
    if (conflictId) {
      const ca = v.conflicts.find((x) => x.id === conflictId);
      if (!ca) return { ok: false, error: `Conflict ${conflictId} not found.` };
      if (ca.hexA !== t.hex && ca.hexB !== t.hex) return { ok: false, error: `${t.callsign} is not in conflict ${conflictId} (${ca.a}/${ca.b}).` };
      traffic = ca.hexA === t.hex ? ca.b : ca.a;
    }
    const requested = goal === "cic_request" && c.request?.hex === t.hex ? c.request.request : null;
    const seeded = seedCandidates(c.candidates, candidatesFor(v, t, goal, requested));
    return {
      ok: true,
      callsign: t.callsign,
      estimatedPhase: phaseOf(v, t),
      owner: v.trackControl[t.hex] ?? null,
      pendingHandoff: v.handoffs.some((h) => h.hex === t.hex && (h.state === "pending" || h.state === "overdue")),
      ...(traffic ? { forTraffic: traffic } : {}),
      candidates: seeded.map(({ key, c: x }) => ({ id: key, phraseology: x.phraseology, deviation: x.deviation, tags: x.tags })),
    };
  },
});

export const issueClearanceTool = createTool({
  id: "issue_clearance",
  description:
    "Issue a known candidate (an agreed APREQ plan or a handoff condition) by candidate id. It is probed again first; a failed probe is refused. Never used for CIC clearance reviews.",
  inputSchema: z.object({ candidateId: z.string() }),
  execute: async ({ candidateId }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    const s = sectorOrError();
    if ("error" in s) return { ok: false, error: s.error };
    const f = findCandidate(c.candidates, candidateId);
    if (!f.ok) return f;
    const v = await getView();
    if (v.trackControl[f.candidate.hex] !== s.sector) return { ok: false, error: `${f.candidate.callsign} is not under your track control.` };
    const r = await issueClearance({ callsign: f.candidate.callsign, req: reqOf(f.candidate), issuedBy: s.sector });
    if (!r.ok) return { ok: false, error: r.error };
    c.issued = { callsign: r.callsign, phraseology: r.phraseology };
    c.actions.push(`issued ${r.phraseology}`);
    return { ok: true, phraseology: r.phraseology, status: r.status };
  },
});

export const initiateHandoff = createTool({
  id: "initiate_handoff",
  description: "Start a handoff of an aircraft you control to the other sector. Fails if you don't have track control or a handoff is already pending.",
  inputSchema: z.object({ callsign: z.string() }),
  execute: async ({ callsign }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    const s = sectorOrError();
    if ("error" in s) return { ok: false, error: s.error };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const to = otherOf(s.sector);
    const r = await airspace().initiateHandoff(t.hex, s.sector, to);
    if (r.ok) c.actions.push(`handoff initiated ${t.callsign} to ${to}`);
    return r;
  },
});

export const checkHandoffEntry = createTool({
  id: "check_handoff_entry",
  description:
    "For an incoming handoff: project the aircraft 90 s ahead (entry point), list your traffic within 3 NM and 1,000 ft of it, any CIC directive that blocks handoffs (directiveBlocks), agreements on the aircraft, and math-generated conditionCandidates you may attach to the acceptance.",
  inputSchema: z.object({ callsign: z.string() }),
  execute: async ({ callsign }) => {
    const c = ctx();
    const s = sectorOrError();
    if ("error" in s) return { ok: false, error: s.error };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const entry = projectStraight(toPosition(t), 90);
    const traffic = v.traffic
      .filter((o) => o.hex !== t.hex && v.trackControl[o.hex] === s.sector)
      .map((o) => {
        const p = projectStraight(toPosition(o), 90);
        return {
          callsign: o.callsign,
          altFt: o.altFt,
          latNm: Math.round(haversineNm(entry.lat, entry.lon, p.lat, p.lon) * 10) / 10,
          vertFt: entry.altFt != null && p.altFt != null ? Math.round(Math.abs(entry.altFt - p.altFt) / 100) * 100 : null,
        };
      })
      .filter((o) => o.latNm < 3 && o.vertFt != null && o.vertFt < 1000);
    const blocks = handoffBlocks(v, s.sector).map((d) => ({ id: d.id, text: d.text, secondsLeft: Math.round((d.expiresAt - Date.now()) / 1000) }));
    const conds = seedCandidates(c.candidates, candidatesFor(v, t, "handoff_condition", null, { owner: s.sector, max: 4 }));
    return {
      ok: true,
      callsign: t.callsign,
      estimatedPhase: phaseOf(v, t),
      entryAltFt: entry.altFt == null ? null : Math.round(entry.altFt / 100) * 100,
      clear: traffic.length === 0,
      traffic,
      directiveBlocks: blocks,
      agreements: liveAgreements(v).filter((a) => a.hex === t.hex).map((a) => a.text),
      conditionCandidates: conds.map(({ key, c: x }) => ({ id: key, phraseology: x.phraseology, deviation: x.deviation, tags: x.tags })),
    };
  },
});

export const acceptHandoff = createTool({
  id: "accept_handoff",
  description:
    "Accept a pending handoff to your sector; track control transfers to you atomically. Optional conditionCandidateId (from check_handoff_entry) is issued after the transfer (probed again) and stored as an agreement.",
  inputSchema: z.object({ callsign: z.string(), conditionCandidateId: z.string().optional() }),
  execute: async ({ callsign, conditionCandidateId }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    const s = sectorOrError();
    if ("error" in s) return { ok: false, error: s.error };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    let cond: CandidateRef | null = null;
    if (conditionCandidateId) {
      const f = findCandidate(c.candidates, conditionCandidateId);
      if (!f.ok) return f;
      if (f.candidate.hex !== t.hex) return { ok: false, error: `Candidate ${conditionCandidateId} is for ${f.candidate.callsign}, not ${t.callsign}.` };
      cond = f.candidate;
    }
    const r = await airspace().acceptHandoff(t.hex, s.sector);
    if (!r.ok) return r;
    c.actions.push(`radar contact ${t.callsign}`);
    if (!cond) return { ok: true, callsign: t.callsign, condition: null };
    const iss = await issueClearance({ callsign: t.callsign, req: reqOf(cond), issuedBy: s.sector });
    if (!iss.ok) return { ok: true, callsign: t.callsign, condition: null, conditionError: `Handoff accepted, but the condition was not issued: ${iss.error}` };
    c.issued = { callsign: iss.callsign, phraseology: iss.phraseology };
    c.actions.push(`condition issued ${iss.phraseology}`);
    const ag = agreementFromCandidate({ hex: t.hex, callsign: t.callsign, candidate: cond, between: ["NORTH", "SOUTH"], source: "handoff" });
    const added = await airspace().addAgreement(ag);
    c.actions.push(`agreement ${added.agreement.text}`);
    return { ok: true, callsign: t.callsign, condition: iss.phraseology, agreement: added.agreement.text };
  },
});

export const rejectHandoff = createTool({
  id: "reject_handoff",
  description: "Reject a pending handoff to your sector (Unable), with the reason.",
  inputSchema: z.object({ callsign: z.string(), reason: z.string() }),
  execute: async ({ callsign, reason }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    const s = sectorOrError();
    if ("error" in s) return { ok: false, error: s.error };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const r = await airspace().rejectHandoff(t.hex, s.sector, reason);
    if (r.ok) c.actions.push(`handoff unable ${t.callsign}`);
    return r;
  },
});

export const updateConflict = createTool({
  id: "update_conflict",
  description: "Update a conflict alert: coordinating (APREQ in progress), resolved (with the agreed plan as resolution), or escalated (to the CIC).",
  inputSchema: z.object({ id: z.string(), state: z.enum(["coordinating", "resolved", "escalated"]), resolution: z.string().optional() }),
  execute: async ({ id, state, resolution }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const r = await airspace().updateConflict(id, { state, ...(resolution ? { resolution } : {}) });
    if (r.ok) ctx().actions.push(`conflict ${id} ${state}`);
    return r;
  },
});

export const addAgreementTool = createTool({
  id: "add_agreement",
  description:
    "Store an agreement with the other sector from a known candidate id (an approved APREQ plan or a handoff condition). The constraint and text come from the candidate. Expires in 5 minutes.",
  inputSchema: z.object({ candidateId: z.string(), source: z.enum(["APREQ", "handoff"]), note: z.string().optional().describe("e.g. 'until clear of JBU811'") }),
  execute: async ({ candidateId, source, note }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    if (c.me === "MONITOR") return { ok: false, error: "MONITOR does not make agreements." };
    const f = findCandidate(c.candidates, candidateId);
    if (!f.ok) return f;
    const cand = f.candidate;
    const ag = agreementFromCandidate({ hex: cand.hex, callsign: cand.callsign, candidate: cand, between: ["NORTH", "SOUTH"], source, ...(note ? { note } : {}) });
    const v = await getView();
    const dup = liveAgreements(v).find(
      (a) => a.hex === ag.hex && a.constraint.kind === ag.constraint.kind && a.constraint.op === ag.constraint.op && a.constraint.value === ag.constraint.value,
    );
    if (dup) return { ok: true, agreement: dup.text, alreadyStored: true };
    const r = await airspace().addAgreement(ag);
    c.actions.push(`agreement ${r.agreement.text}`);
    return { ok: true, agreement: r.agreement.text, id: r.agreement.id };
  },
});

export const addDirectiveTool = createTool({
  id: "add_directive",
  description:
    "Store a CIC directive so every agent follows it until it expires. target: your sector, or ALL (only NORTH stores ALL directives). text: the CIC's words. rule: no_handoffs | altitude_cap | altitude_floor | other (value in feet for altitude rules, from the CIC's words). expiresInSec: the duration the CIC said (default 300).",
  inputSchema: z.object({
    target: z.enum(["NORTH", "SOUTH", "ALL"]),
    text: z.string(),
    rule: z.object({ type: z.enum(["no_handoffs", "altitude_cap", "altitude_floor", "other"]), value: z.number().optional() }).optional(),
    expiresInSec: z.number().int().positive().max(3600).optional(),
  }),
  execute: async ({ target, text, rule, expiresInSec }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    if (c.me === "MONITOR") return { ok: false, error: "MONITOR does not store directives." };
    if (target === "ALL" && c.me !== "NORTH") return { ok: false, error: "NORTH stores all-sector directives. Just acknowledge." };
    if (target !== "ALL" && target !== c.me) return { ok: false, error: `${target} stores its own directives. Do not store it.` };
    const v = await getView();
    const dup = liveDirectives(v).find((d) => d.target === target && d.text.trim().toLowerCase() === text.trim().toLowerCase());
    if (dup) return { ok: true, directive: dup.text, alreadyStored: true };
    const r = await airspace().addDirective({
      target,
      text,
      ...(rule ? { rule: { type: rule.type, ...(rule.value != null ? { value: rule.value } : {}) } } : {}),
      ...(expiresInSec ? { expiresInSec } : {}),
    });
    c.actions.push(`directive ${target}: ${text}`);
    return { ok: true, id: r.directive.id, expiresInSec: Math.round((r.directive.expiresAt - Date.now()) / 1000) };
  },
});

export const submitReview = createTool({
  id: "submit_review",
  description:
    "Finish a CIC clearance review (call exactly once). decision: issue | unable | confirm | coordinate. chosenCandidateId: required for unable when candidates exist (the recommended alternative, by id). phraseology: what you say to the CIC. reason: one or two sentences naming the deciding facts. question: required for confirm. coordinationMessage: required for coordinate (the point out text). Returns ok:false with the rule broken so you can fix it.",
  inputSchema: z.object({
    decision: z.enum(["issue", "unable", "confirm", "coordinate"]),
    chosenCandidateId: z.string().optional(),
    phraseology: z.string(),
    reason: z.string(),
    question: z.string().optional(),
    coordinationMessage: z.string().optional(),
  }),
  execute: async (input) => {
    const c = ctx();
    if (!c.reviewFacts) return { ok: false, error: "submit_review is only for CIC clearance review turns." };
    if (c.review) return { ok: false, error: "Review already submitted for this request." };
    let chosen = input.chosenCandidateId || undefined;
    // Accept the qualified form ("UAL123:c2") for review candidates, which are keyed by plain id.
    if (chosen && !c.reviewFacts.candidates.some((x) => x.id === chosen)) {
      const f = findCandidate(c.candidates, chosen);
      if (f.ok && f.candidate.hex === c.request?.hex && c.reviewFacts.candidates.some((x) => x.id === f.candidate.id)) chosen = f.candidate.id;
    }
    const review: SectorReview = {
      decision: input.decision,
      ...(chosen ? { chosenCandidateId: chosen } : {}),
      phraseology: input.phraseology.trim(),
      reason: input.reason.trim(),
      ...(input.question?.trim() ? { question: input.question.trim() } : {}),
      ...(input.coordinationMessage?.trim() ? { coordinationMessage: input.coordinationMessage.trim() } : {}),
    };
    const v = validateReview(review, c.reviewFacts);
    if (!v.ok) return { ok: false, error: v.error };
    c.review = review;
    c.actions.push(`review ${review.decision}${review.chosenCandidateId ? ` ${review.chosenCandidateId}` : ""}`);
    return { ok: true, decision: review.decision, note: "Review submitted. Stop now; the workflow delivers it." };
  },
});

export const sendPointOut = createTool({
  id: "send_point_out",
  description: "Send a point out to the other sector about the aircraft in the current clearance request (normally done for you after a coordinate review).",
  inputSchema: z.object({ to: SectorEnum, text: z.string() }),
  execute: async ({ to, text }) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    if (to === c.me) return { ok: false, error: "Cannot point out to yourself." };
    if (!c.request) return { ok: false, error: "No clearance request in this turn to point out." };
    const m = await c.relay.dm(to, text, meta({ type: "POINT_OUT", hex: c.request.hex, callsign: c.request.callsign, request: c.request.request }));
    c.sent.push(m);
    return { ok: true, id: m.id };
  },
});

export const replyPointOut = createTool({
  id: "reply_point_out",
  description: 'Answer the point out in this turn: approved true ("Point out approved.") or false with the reason (traffic or CIC directive).',
  inputSchema: z.object({ approved: z.boolean(), reason: z.string().optional(), callsign: z.string().optional() }),
  execute: async ({ approved, reason }) => {
    const c = ctx();
    const po = c.pointOut;
    if (!po) return { ok: false, error: "No point out to answer in this turn." };
    if (po.replied) return { ok: false, error: "Already replied." };
    if (!approved && !reason?.trim()) return { ok: false, error: "Unable requires a reason (the traffic or the directive)." };
    const text = approved ? "Point out approved." : `Unable, ${reason!.trim().replace(/\.$/, "")}.`;
    const m = await c.relay.dm(po.from, text, {
      type: "POINT_OUT_REPLY",
      requestId: po.requestId,
      session: c.session,
      from: c.me,
      callsign: po.callsign,
      approved,
      ...(approved ? {} : { reason: reason!.trim() }),
      inReplyTo: c.eventId,
    });
    po.replied = true;
    c.sent.push(m);
    c.actions.push(`point out ${approved ? "approved" : "unable"}`);
    return { ok: true, text };
  },
});

export const sendDm = createTool({
  id: "send_dm",
  description:
    "Send a direct message over Agent Relay to another controller (NORTH, SOUTH, MONITOR) or the CIC, in standard phraseology. For kind APREQ (and APREQ_REPLY counter-proposals) pass candidateId: the full math-checked candidate is attached for the other sector.",
  inputSchema: z.object({
    to: z.enum(["NORTH", "SOUTH", "MONITOR", "CIC"]),
    text: z.string(),
    kind: MsgKind.optional(),
    callsign: z.string().optional(),
    conflictId: z.string().optional(),
    approved: z.boolean().optional().describe("For APREQ_REPLY: true = approved, false = unable/counter-proposal"),
    candidateId: z.string().optional().describe("For APREQ / APREQ_REPLY: the candidate proposed, approved, or counter-proposed"),
    reason: z.string().optional().describe("For APREQ / counter-proposals: why this option (the deciding facts)"),
  }),
  execute: async (input) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    if (input.to === c.me) return { ok: false, error: "Cannot DM yourself." };
    const kind = input.kind ?? "INFO";
    let candidateData: Record<string, unknown> = {};
    if (kind === "APREQ" || kind === "APREQ_REPLY") {
      const id = input.candidateId || (kind === "APREQ_REPLY" && input.approved === true ? c.proposedKey : undefined);
      if (kind === "APREQ" && !id) return { ok: false, error: "APREQ requires candidateId (from the listed candidates)." };
      if (id) {
        const f = findCandidate(c.candidates, id);
        if (!f.ok) return f;
        const cand = f.candidate;
        const pr = await probeFor(cand.callsign, reqOf(cand));
        if (!pr.ok) return { ok: false, error: pr.error };
        if (!pr.probe.ok) return { ok: false, error: `Candidate ${f.key} no longer passes the probe: ${pr.probe.reasons.join(" ")} Pick another.` };
        candidateData = { callsign: cand.callsign, hex: cand.hex, candidate: cand, ...(input.reason ? { reason: input.reason } : {}) };
      }
    }
    const m = await c.relay.dm(
      input.to,
      input.text,
      meta({
        type: kind,
        ...(input.callsign ? { callsign: input.callsign } : {}),
        ...(input.conflictId ? { conflictId: input.conflictId } : {}),
        ...(input.approved !== undefined ? { approved: input.approved } : {}),
        ...candidateData,
      }),
    );
    c.sent.push(m);
    return { ok: true, id: m.id };
  },
});

export const postTool = createTool({
  id: "post",
  description: "Post a message to an Agent Relay channel: coord (coordination plans, advisories), alerts (conformance), cic (to the Controller-in-Charge).",
  inputSchema: z.object({ channel: z.enum(["coord", "alerts", "cic"]), text: z.string(), kind: MsgKind.optional() }),
  execute: async (input) => {
    const refused = refuseInReview();
    if (refused) return refused;
    const c = ctx();
    const m = await c.relay.post(input.channel, input.text, meta({ type: input.kind ?? "INFO" }));
    c.sent.push(m);
    return { ok: true, id: m.id };
  },
});

export const sectorTools = bindTurn({
  get_sector_picture: getSectorPicture,
  probe_clearance: probeClearanceTool,
  get_candidates: getCandidates,
  submit_review: submitReview,
  issue_clearance: issueClearanceTool,
  initiate_handoff: initiateHandoff,
  check_handoff_entry: checkHandoffEntry,
  accept_handoff: acceptHandoff,
  reject_handoff: rejectHandoff,
  update_conflict: updateConflict,
  add_agreement: addAgreementTool,
  add_directive: addDirectiveTool,
  send_point_out: sendPointOut,
  reply_point_out: replyPointOut,
  send_dm: sendDm,
  post: postTool,
});

export const monitorTools = bindTurn({
  get_sector_picture: getSectorPicture,
  send_dm: sendDm,
  post: postTool,
});
