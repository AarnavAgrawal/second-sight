// Clearance workflow (CLAUDE.md 11a, upgraded by ai-updates.md 5):
//   parse -> resolve -> probe -> context -> sectorReview -> coordinate -> issue -> result
// Every clearance, voice or typed, runs through here. Each step has Zod input/output schemas.
// Safety rule: math (shared/) answers "is it safe?" and generates every option; the sector agent only chooses
// between validated candidates (by id) and explains why. The workflow validates the agent's review and falls
// back to a deterministic decision if the agent misbehaves or times out. See docs/ai-protocol.md.
// Once a step produces a final answer (say again, unable, confirm, issued), later steps pass it through.
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { aircraft, airspace } from "../../../shared/adapters/actors.ts";
import type { Relay, RelayMessage } from "../../../shared/adapters/relay.ts";
import { activeAgreements, checkAgreements, recentConflictingClearance } from "../../../shared/agreements.ts";
import { generateCandidates } from "../../../shared/candidates.ts";
import { flightPhase } from "../../../shared/phase.ts";
import { clearancePhrase, unablePhrase } from "../../../shared/phraseology.ts";
import { probeClearance } from "../../../shared/probe.ts";
import { sectorEntry } from "../../../shared/sectorEntry.ts";
import { spokenCallsign } from "../../../shared/telephony.ts";
import type { Candidate, ClearanceRequest, ProbeResult, ReviewFacts, SectorReview } from "../../../shared/types.ts";
import { parseClearance } from "../agents/parser.ts";
import { issueClearance } from "../ops.ts";
import { fallbackReview, validateReview } from "../tools/review.ts";
import { findAircraft, getView, toPosition } from "../view.ts";

// ---- dependencies injected by the bridge ----
const deps: { relay: Relay | null; reviewTimeoutMs: number; pointOutTimeoutMs: number; mode: "agents" | "direct" } = {
  relay: null,
  reviewTimeoutMs: Number(process.env.SECTOR_REVIEW_TIMEOUT_MS || 8000),
  pointOutTimeoutMs: Number(process.env.POINT_OUT_TIMEOUT_MS || 8000),
  mode: (process.env.CLEARANCE_MODE || "agents") === "direct" ? "direct" : "agents",
};
export function configureClearanceWorkflow(d: { relay: Relay | null }) {
  deps.relay = d.relay;
}

/** Step progress listeners, keyed by a token passed in the workflow input (for SSE streaming to the UI). */
export type StepEvent = { id: string; status: "ok" | "fail" | "skipped"; detail: string; ms: number };
const progress = new Map<string, (e: StepEvent) => void>();

// ---- schemas ----
const StepId = z.enum(["parse", "resolve", "probe", "context", "sectorReview", "coordinate", "issue"]);
const StepLog = z.object({ id: StepId, status: z.enum(["ok", "fail", "skipped"]), detail: z.string(), ms: z.number() });
const Sector = z.enum(["NORTH", "SOUTH"]);
const Parsed = z.object({ callsign: z.string(), kind: z.enum(["altitude", "heading"]), value: z.number(), turn: z.enum(["left", "right"]).optional() });
const Alternative = z.object({
  callsign: z.string(),
  kind: z.enum(["altitude", "heading"]),
  value: z.number(),
  turn: z.enum(["left", "right"]).optional(),
  /** Standard phraseology; also valid as `text` for POST /clearance. */
  text: z.string(),
  /** Candidate id from the facts packet (when chosen by the sector agent or the fallback). */
  candidateId: z.string().optional(),
});
const Review = z.object({
  decision: z.enum(["issue", "unable", "confirm", "coordinate"]),
  by: z.enum(["NORTH", "SOUTH", "FALLBACK"]),
  reason: z.string(),
  question: z.string().optional(),
  pointOut: z.object({ to: Sector, result: z.enum(["approved", "unable", "no_response"]), reason: z.string().optional() }).optional(),
});

export const ClearanceResultSchema = z.object({
  issued: z.boolean(),
  transcript: z.string(),
  parsed: Parsed.optional(),
  hex: z.string().optional(),
  sector: Sector.optional(),
  phraseology: z.string().optional(),
  probe: z.any().optional(),
  reason: z.string().optional(),
  alternative: Alternative.optional(),
  sayAgain: z.boolean().optional(),
  suggestions: z.array(z.string()).optional(),
  /** "Say again" spoken alternatives, e.g. ["Southwest twenty-one forty", "Southwest twenty-one fifty-five"]. */
  options: z.array(z.string()).optional(),
  override: z.boolean().optional(),
  /** ai-updates.md 10: the sector controller's decision and why. */
  review: Review.optional(),
  needsConfirm: z.boolean().optional(),
  question: z.string().optional(),
  steps: z.array(StepLog),
});
export type ClearanceResult = z.infer<typeof ClearanceResultSchema>;

const Flow = z.object({
  text: z.string(),
  override: z.boolean(),
  confirmed: z.boolean().default(false),
  parsed: Parsed.nullable(),
  hex: z.string().nullable(),
  callsign: z.string().nullable(),
  sector: Sector.nullable(),
  currentAltFt: z.number().nullable(),
  phraseology: z.string().nullable(),
  probe: z.any().nullable(),
  facts: z.any().nullable().default(null),
  review: z.any().nullable().default(null),
  reviewBy: z.enum(["NORTH", "SOUTH", "FALLBACK"]).nullable().default(null),
  pointOut: z.any().nullable().default(null),
  steps: z.array(StepLog),
  final: ClearanceResultSchema.nullable(),
  progressToken: z.string().nullable(),
});
export type Flow = z.infer<typeof Flow>;

export const ClearanceInputSchema = z.object({
  text: z.string(),
  override: z.boolean().optional(),
  /** The CIC confirmed a "Confirm, ...?" question (ai-updates.md 6 confirm). */
  confirmed: z.boolean().optional(),
  selectedHex: z.string().nullable().optional(),
  /** Optional structured clearance (e.g. the chosen alternative). When present, the parse step skips the LLM. */
  clearance: Parsed.optional(),
  progressToken: z.string().optional(),
});

export const log = (f: Flow, id: z.infer<typeof StepId>, status: "ok" | "fail" | "skipped", detail: string, t0: number): Flow => {
  const entry = { id, status, detail, ms: Date.now() - t0 };
  if (f.progressToken) progress.get(f.progressToken)?.(entry);
  return { ...f, steps: [...f.steps, entry] };
};
export const finish = (f: Flow, extra: Partial<ClearanceResult> & { issued: boolean }): Flow => ({
  ...f,
  final: {
    transcript: f.text,
    ...(f.parsed ? { parsed: f.parsed } : {}),
    ...(f.hex ? { hex: f.hex } : {}),
    ...(f.sector ? { sector: f.sector } : {}),
    ...(f.phraseology ? { phraseology: f.phraseology } : {}),
    ...(f.probe ? { probe: f.probe } : {}),
    ...(f.override ? { override: true } : {}),
    steps: f.steps,
    ...extra,
  },
});
const toReq = (p: z.infer<typeof Parsed>): ClearanceRequest => ({ kind: p.kind, value: p.value, ...(p.turn ? { turn: p.turn } : {}) });

/** The probe's own alternative (used when no candidate was chosen). */
export function alternativeOf(f: Flow): z.infer<typeof Alternative> | undefined {
  const alt = (f.probe as ProbeResult | null)?.alternative;
  if (!alt || !f.callsign) return undefined;
  return { callsign: f.callsign, kind: alt.kind, value: alt.value, ...(alt.turn ? { turn: alt.turn } : {}), text: clearancePhrase(f.callsign, alt, f.currentAltFt) };
}

/** A math-generated candidate as the response's `alternative`. */
export function alternativeFromCandidate(f: Flow, c: Candidate | undefined): z.infer<typeof Alternative> | undefined {
  if (!c || !f.callsign) return alternativeOf(f);
  return { callsign: f.callsign, kind: c.kind, value: c.value, ...(c.turn ? { turn: c.turn } : {}), text: c.phraseology, candidateId: c.id };
}

/** Resolve the first message matching `pred` seen anywhere in the workspace (DMs between sectors included). */
function waitForAny(relay: Relay, pred: (m: RelayMessage) => boolean, timeoutMs: number): { promise: Promise<RelayMessage | null>; cancel: () => void } {
  let done = false;
  let unsub: () => void = () => {};
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<RelayMessage | null>((resolve) => {
    const finishWith = (m: RelayMessage | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(m);
    };
    unsub = relay.watchAll((m) => {
      if (pred(m)) finishWith(m);
    });
    timer = setTimeout(() => finishWith(null), timeoutMs);
  });
  return { promise, cancel: () => { if (!done) { done = true; clearTimeout(timer); unsub(); } } };
}

/** Live point-out waiters, keyed by requestId (kept out of step data: Promises don't survive step serialization). */
const pointOutWaits = new Map<string, ReturnType<typeof waitForAny>>();

const postCic = (text: string, data: Record<string, unknown>) =>
  deps.relay?.post("cic", text, data).catch((e) => console.error("[clearance] #cic post failed:", (e as Error).message));

// ---- steps ----
const parseStep = createStep({
  id: "parse",
  description: "Clearance parser agent turns the CIC transmission into { callsign, kind, value, turn, confidence }. Low confidence or an ambiguous callsign returns 'Say again'.",
  inputSchema: ClearanceInputSchema,
  outputSchema: Flow,
  execute: async ({ inputData }) => {
    const t0 = Date.now();
    let f: Flow = {
      text: inputData.text.trim(),
      override: !!inputData.override,
      confirmed: !!inputData.confirmed,
      parsed: null,
      hex: null,
      callsign: null,
      sector: null,
      currentAltFt: null,
      phraseology: null,
      probe: null,
      facts: null,
      review: null,
      reviewBy: null,
      pointOut: null,
      steps: [],
      final: null,
      progressToken: inputData.progressToken ?? null,
    };
    const v = await getView();
    if (!v.airport) return finish(log(f, "parse", "fail", "No active airport.", t0), { issued: false, reason: "No active airport.", sayAgain: true });
    if (inputData.clearance) {
      const c = inputData.clearance;
      f.parsed = { callsign: c.callsign, kind: c.kind, value: c.value, ...(c.turn ? { turn: c.turn } : {}) };
      return log(f, "parse", "ok", `Structured clearance: ${c.callsign} ${c.kind} ${c.value}${c.turn ? ` ${c.turn}` : ""}`, t0);
    }
    // Selected aircraft first so the parser prefers it on ambiguity.
    const sel = inputData.selectedHex ? v.traffic.filter((t) => t.hex === inputData.selectedHex) : [];
    const cands = [...sel, ...v.traffic.filter((t) => t.hex !== inputData.selectedHex)].map((t) => ({ callsign: t.callsign, spoken: spokenCallsign(t.callsign) }));
    const recent = (v.clearanceLog ?? []).slice(-3).map((c) => c.phraseology);
    try {
      const p = await parseClearance(f.text, cands, recent);
      const known = new Set(cands.map((c) => c.callsign));
      const ambiguous = (p.ambiguousWith ?? []).filter((cs) => known.has(cs));
      if (ambiguous.length > 1 || (p.confidence === "low" && ambiguous.length > 0)) {
        // "Say again, which Southwest, twenty-one forty or twenty-one fifty-five?"
        const spoken = ambiguous.map(spokenCallsign);
        const firstWords = spoken.map((s) => s.split(" ")[0]);
        const sameAirline = firstWords.every((w) => w === firstWords[0]);
        const question = sameAirline
          ? `Say again, which ${firstWords[0]}, ${spoken.map((s) => s.split(" ").slice(1).join(" ")).join(" or ")}?`
          : `Say again, ${spoken.join(" or ")}?`;
        f = log(f, "parse", "fail", `Ambiguous callsign: ${ambiguous.join(", ")}`, t0);
        return finish(f, { issued: false, reason: question, sayAgain: true, suggestions: ambiguous, options: spoken });
      }
      if (!p.callsign || !p.kind || p.value == null || p.confidence === "low") {
        const words = f.text.toLowerCase();
        const suggestions = cands.filter((c) => c.spoken.toLowerCase().split(" ").some((w) => w.length > 3 && words.includes(w))).slice(0, 5).map((c) => c.callsign);
        f = log(f, "parse", "fail", p.problem ?? "Could not parse a clearance.", t0);
        return finish(f, { issued: false, reason: `Say again. ${p.problem ?? ""}`.trim(), sayAgain: true, suggestions, options: suggestions.map(spokenCallsign) });
      }
      f.parsed = { callsign: p.callsign, kind: p.kind, value: p.value, ...(p.turn ? { turn: p.turn } : {}) };
      return log(f, "parse", "ok", `${p.callsign} ${p.kind} ${p.value}${p.turn ? ` ${p.turn}` : ""}`, t0);
    } catch (e) {
      f = log(f, "parse", "fail", `Parser error: ${(e as Error).message}`, t0);
      return finish(f, { issued: false, reason: "Say again. The clearance parser is unavailable.", sayAgain: true });
    }
  },
});

const resolveStep = createStep({
  id: "resolve",
  description: "Match the callsign against Airspace.traffic and look up track control.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed) return f;
    const t0 = Date.now();
    const v = await getView();
    const t = findAircraft(v, f.parsed.callsign);
    if (!t) {
      const g = log(f, "resolve", "fail", `${f.parsed.callsign} not in radar contact.`, t0);
      return finish(g, { issued: false, reason: `Say again. ${f.parsed.callsign} not in radar contact.`, sayAgain: true });
    }
    const sector = v.trackControl[t.hex] ?? (v.airport && t.lat >= v.airport.lat ? "NORTH" : "SOUTH");
    const g: Flow = { ...f, hex: t.hex, callsign: t.callsign, sector, currentAltFt: t.altFt, phraseology: clearancePhrase(t.callsign, toReq(f.parsed), t.altFt) };
    return log(g, "resolve", "ok", `${t.callsign} (${t.hex}) owned by ${sector}`, t0);
  },
});

const probeStep = createStep({
  id: "probe",
  description: "Run probeClearance from shared/ (plain code) on fresh traffic.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex) return f;
    const t0 = Date.now();
    const v = await getView();
    const t = v.traffic.find((x) => x.hex === f.hex);
    if (!v.airport || !t) return finish(log(f, "probe", "fail", "Aircraft lost.", t0), { issued: false, reason: "Unable. Radar contact lost." });
    const probe = probeClearance(toPosition(t), toReq(f.parsed), v.positions, v.airport);
    const g = { ...f, probe };
    return log(g, "probe", probe.ok ? "ok" : "fail", probe.ok ? "No conflicts. Valid." : probe.reasons.join(" "), t0);
  },
});

/** Build the facts packet (ai-updates.md 5 step 4). Plain code only; the agent reasons over it. */
export async function buildFacts(f: Flow): Promise<ReviewFacts | null> {
  if (!f.parsed || !f.hex || !f.sector) return null;
  const v = await getView();
  const t = v.traffic.find((x) => x.hex === f.hex);
  if (!v.airport || !t) return null;
  const now = Date.now();
  const pos = toPosition(t);
  const req = toReq(f.parsed);
  const agreements = activeAgreements(v.agreements ?? [], now);
  // Only aircraft that have had a clearance have an Aircraft actor; don't create empty ones.
  const prev = v.statuses[f.hex] ? (await aircraft(f.hex).getState()).clearance : null;
  const candidates = generateCandidates(pos, req, v.positions, v.airport, { goal: "cic_request", agreements, owner: f.sector, now });
  const probe = f.probe as ProbeResult;
  return {
    phase: flightPhase(pos, v.airport),
    probe: { ...probe, alternatives: candidates },
    candidates,
    brokenAgreements: checkAgreements(f.hex, req, agreements, now),
    recentConflict: recentConflictingClearance(prev, req, t.altFt, now),
    sectorEntry: sectorEntry(pos, req, v.airport, f.sector),
    directives: (v.directives ?? []).filter((d) => d.state === "active" && d.expiresAt > now && (d.target === "ALL" || d.target === f.sector)),
    confirmed: f.confirmed,
  };
}

const contextStep = createStep({
  id: "context",
  description: "Facts packet for the sector controller: flight phase, safe candidates, broken agreements, recent conflicting clearance, sector entry, active directives.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex) return f;
    const t0 = Date.now();
    const facts = await buildFacts(f);
    if (!facts) return finish(log(f, "context", "fail", "Aircraft lost.", t0), { issued: false, reason: "Unable. Radar contact lost." });
    const bits = [
      `estimated phase ${facts.phase}`,
      `${facts.candidates.length} safe candidate${facts.candidates.length === 1 ? "" : "s"}`,
      facts.brokenAgreements.length ? `breaks ${facts.brokenAgreements.map((a) => a.text).join("; ")}` : "",
      facts.recentConflict ? `recent clearance: ${facts.recentConflict.why}` : "",
      facts.sectorEntry.entersOther ? `enters ${facts.sectorEntry.sector} in ${facts.sectorEntry.inSec} s` : "",
      facts.directives.length ? `${facts.directives.length} directive(s)` : "",
    ].filter(Boolean);
    // Expose all candidates on the probe result for the UI (ProbeResult.alternatives).
    return log({ ...f, facts, probe: facts.probe }, "context", "ok", bits.join(", "), t0);
  },
});

/** Deterministic review used when sector agents aren't running (CLEARANCE_MODE=direct or Relay offline). */
function directReview(facts: ReviewFacts, requestedPhraseology: string): SectorReview {
  const blocked = !facts.probe.ok || (!facts.confirmed && (facts.brokenAgreements.length > 0 || !!facts.recentConflict));
  if (!blocked) return { decision: "issue", phraseology: requestedPhraseology, reason: "Direct mode: probe clean." };
  return fallbackReview({ ...facts, sectorEntry: { entersOther: false } }, requestedPhraseology);
}

const sectorReviewStep = createStep({
  id: "sectorReview",
  description:
    "DM the owning sector controller agent the request, probe result and facts packet; it must submit_review (issue | unable | confirm | coordinate, choosing candidate ids). The workflow validates the review and falls back deterministically.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex || !f.callsign || !f.sector) return f;
    const t0 = Date.now();
    const req = toReq(f.parsed);
    const facts = f.facts as ReviewFacts;
    const requested = f.phraseology ?? clearancePhrase(f.callsign, req, f.currentAltFt);

    if (f.override) return log(f, "sectorReview", "skipped", "CIC override: sector review skipped.", t0);

    if (deps.mode === "direct" || !deps.relay) {
      const review = directReview(facts, requested);
      return log({ ...f, review, reviewBy: "FALLBACK" }, "sectorReview", "skipped", deps.relay ? "Direct mode: rules decided." : "Relay offline: rules decided.", t0);
    }

    const relay = deps.relay;
    const requestId = `CLR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Start watching for the point-out reply now (it can arrive while we wait for the review).
    const pointOutWait = waitForAny(
      relay,
      (m) => (m.data as { type?: string; requestId?: string } | null)?.type === "POINT_OUT_REPLY" && (m.data as { requestId?: string }).requestId === requestId,
      deps.reviewTimeoutMs + deps.pointOutTimeoutMs + 2000,
    );
    const reply = relay.waitFor(
      (m) => m.from === f.sector && (m.data as { type?: string; requestId?: string } | null)?.type === "REVIEW" && (m.data as { requestId?: string }).requestId === requestId,
      deps.reviewTimeoutMs,
    );
    const summary = [
      facts.probe.ok ? "Probe clean." : `Probe FAILED: ${facts.probe.reasons.join(" ")}`,
      facts.brokenAgreements.length ? `Breaks agreement: ${facts.brokenAgreements.map((a) => a.text).join("; ")}.` : "",
      facts.recentConflict ? `Recent clearance: ${facts.recentConflict.why}.` : "",
      facts.sectorEntry.entersOther ? `Enters ${facts.sectorEntry.sector} in ${facts.sectorEntry.inSec} s.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    await relay
      .dm(f.sector, `Review: ${requested} ${summary}`, {
        type: "CLEARANCE_REVIEW",
        requestId,
        session: (await getView()).session,
        hex: f.hex,
        callsign: f.callsign,
        request: req,
        requestedPhraseology: requested,
        facts,
      })
      .catch((e) => console.error("[clearance] review DM failed:", (e as Error).message));
    const m = await reply;

    const submitted = (m?.data as { review?: SectorReview | null } | undefined)?.review ?? null;
    const check = submitted ? validateReview(submitted, facts) : ({ ok: false, error: m ? "no review submitted" : `no response in ${Math.round(deps.reviewTimeoutMs / 1000)} s` } as const);
    if (submitted && check.ok) {
      const g = { ...f, review: submitted, reviewBy: f.sector, pointOut: { requestId } };
      // Keep the point-out watcher only when the sector is coordinating.
      if (submitted.decision === "coordinate") pointOutWaits.set(requestId, pointOutWait);
      else pointOutWait.cancel();
      return log(g, "sectorReview", "ok", `${f.sector}: ${submitted.decision}. ${submitted.reason}`, t0);
    }
    pointOutWait.cancel();
    const fb = fallbackReview(facts, requested);
    const why = check.ok ? "" : check.error;
    void postCic(`Automatic fallback for ${f.callsign} (${f.sector} ${why}): ${fb.phraseology}`, { type: "FALLBACK", hex: f.hex, callsign: f.callsign, reason: why, review: fb });
    return log({ ...f, review: fb, reviewBy: "FALLBACK" }, "sectorReview", "fail", `Fallback used (${why}).`, t0);
  },
});

const coordinateStep = createStep({
  id: "coordinate",
  description: "Only for decision 'coordinate': the sector sent a point out to the other sector over Relay; wait for 'point out approved' / 'unable'.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    const review = f.review as SectorReview | null;
    if (f.final || !review || review.decision !== "coordinate" || !f.sector) return f;
    const t0 = Date.now();
    const other = f.sector === "NORTH" ? "SOUTH" : "NORTH";
    const requestId = (f.pointOut as { requestId?: string } | null)?.requestId ?? "";
    const wait = pointOutWaits.get(requestId);
    pointOutWaits.delete(requestId);
    const m = wait ? await wait.promise : null;
    const d = (m?.data ?? null) as { approved?: boolean; reason?: string } | null;
    const pointOut = m ? { to: other, result: d?.approved ? "approved" : "unable", ...(d?.reason || m.text ? { reason: d?.reason ?? m.text } : {}) } : { to: other, result: "no_response" };
    const ok = pointOut.result === "approved";
    return log({ ...f, pointOut }, "coordinate", ok ? "ok" : "fail", `${other}: ${m ? m.text : `no response in ${Math.round(deps.pointOutTimeoutMs / 1000)} s`}`, t0);
  },
});

const issueStep = createStep({
  id: "issue",
  description: "Act on the decision: issue (Aircraft actor), unable (with the chosen candidate as the alternative), confirm (question to the CIC), coordinate (issue only if the point out was approved). CIC override issues directly.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex || !f.callsign || !f.sector) return f;
    const t0 = Date.now();
    const req = toReq(f.parsed);
    const probe = f.probe as ProbeResult;
    const facts = f.facts as ReviewFacts | null;

    if (f.override) {
      const r = await issueClearance({ callsign: f.callsign, req, issuedBy: "CIC", override: true });
      if (!r.ok) return finish(log(f, "issue", "fail", r.error, t0), { issued: false, reason: r.error });
      const warn = probe.ok ? "Probe clean." : `Probe warnings: ${probe.reasons.join(" ")}`;
      const text = `CIC override: ${r.phraseology} ${warn}`;
      await airspace().addAlert({ ts: Date.now(), kind: "OVERRIDE", text });
      void postCic(text, { type: "OVERRIDE", hex: f.hex, callsign: f.callsign, clearance: req, probe });
      return finish(log(f, "issue", "ok", r.phraseology, t0), { issued: true, phraseology: r.phraseology });
    }

    const review = f.review as SectorReview | null;
    if (!review || !facts) return finish(log(f, "issue", "fail", "No review.", t0), { issued: false, reason: unablePhrase(f.callsign, req, probe), alternative: alternativeOf(f) });
    const by = f.reviewBy ?? "FALLBACK";
    const pointOut = f.pointOut as { to: "NORTH" | "SOUTH"; result: "approved" | "unable" | "no_response"; reason?: string } | null;
    const reviewOut = {
      decision: review.decision,
      by,
      reason: review.reason,
      ...(review.question ? { question: review.question } : {}),
      ...(review.decision === "coordinate" && pointOut?.result ? { pointOut } : {}),
    };
    const chosen = review.chosenCandidateId ? facts.candidates.find((c) => c.id === review.chosenCandidateId) : undefined;

    if (review.decision === "unable") {
      const g = log(f, "issue", "skipped", "Not issued: unable.", t0);
      return finish(g, { issued: false, reason: review.phraseology || unablePhrase(f.callsign, req, probe), alternative: alternativeFromCandidate(f, chosen), review: reviewOut });
    }
    if (review.decision === "confirm") {
      const question = review.question ?? review.phraseology;
      const g = log(f, "issue", "skipped", "Awaiting CIC confirmation.", t0);
      return finish(g, { issued: false, needsConfirm: true, question, reason: question, review: reviewOut });
    }
    if (review.decision === "coordinate" && pointOut?.result !== "approved") {
      const why = pointOut?.result === "unable" ? pointOut.reason ?? `${pointOut.to} unable.` : `No response from ${pointOut?.to ?? "the other sector"} to the point out.`;
      const g = log(f, "issue", "skipped", "Not issued: point out not approved.", t0);
      return finish(g, { issued: false, reason: `Unable, ${spokenCallsign(f.callsign)}. ${why}`, alternative: alternativeFromCandidate(f, facts.candidates.find((c) => !c.tags.includes("enters_other_sector_120s"))), review: reviewOut });
    }

    // issue, or coordinate with the point out approved
    const r = await issueClearance({ callsign: f.callsign, req, issuedBy: f.sector });
    if (!r.ok) return finish(log(f, "issue", "fail", r.error, t0), { issued: false, reason: r.error, alternative: alternativeFromCandidate(f, facts.candidates[0]), review: reviewOut });
    if (f.confirmed && facts.brokenAgreements.length) {
      for (const a of facts.brokenAgreements) {
        await airspace().expireAgreement(a.id, "cancelled by CIC");
        await deps.relay?.post("coord", `Agreement cancelled by CIC: ${a.text}.`, { type: "AGREEMENT_CANCELLED", agreementId: a.id, hex: a.hex }).catch(() => {});
      }
    }
    // The sector's REVIEW DM already speaks the clearance in agent mode; show it in #cic for direct mode/fallback.
    if (by === "FALLBACK") void postCic(r.phraseology, { type: "CLEARANCE", callsign: f.callsign, hex: f.hex, sector: f.sector, clearance: req, probe });
    return finish(log(f, "issue", "ok", r.phraseology, t0), { issued: true, phraseology: r.phraseology, review: reviewOut });
  },
});

const resultStep = createStep({
  id: "result",
  description: "Return the final response.",
  inputSchema: Flow,
  outputSchema: ClearanceResultSchema,
  execute: async ({ inputData: f }) => f.final ?? { issued: false, transcript: f.text, reason: "Say again.", sayAgain: true, steps: f.steps },
});

export const clearanceWorkflow = createWorkflow({
  id: "clearance",
  description: "CIC clearance: parse, resolve, probe, context, sector review, coordinate, issue.",
  inputSchema: ClearanceInputSchema,
  outputSchema: ClearanceResultSchema,
})
  .then(parseStep)
  .then(resolveStep)
  .then(probeStep)
  .then(contextStep)
  .then(sectorReviewStep)
  .then(coordinateStep)
  .then(issueStep)
  .then(resultStep)
  .commit();

export async function runClearance(input: z.infer<typeof ClearanceInputSchema>, onStep?: (e: StepEvent) => void): Promise<ClearanceResult> {
  const token = onStep ? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined;
  if (token && onStep) progress.set(token, onStep);
  try {
    return await runClearanceInner({ ...input, ...(token ? { progressToken: token } : {}) });
  } finally {
    if (token) progress.delete(token);
  }
}

async function runClearanceInner(input: z.infer<typeof ClearanceInputSchema>): Promise<ClearanceResult> {
  const run = await clearanceWorkflow.createRun();
  const res = await run.start({ inputData: input });
  if (res.status === "success") return res.result as ClearanceResult;
  const err = res.status === "failed" ? String((res as { error?: unknown }).error ?? "workflow failed") : res.status;
  return { issued: false, transcript: input.text, reason: `Clearance workflow ${err}.`, steps: [] };
}
