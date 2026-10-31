// Shadow evaluation: replay what the real controller said (heard on the frequency) through Second Sight's
// decision path at that moment of recorded traffic, and compare with what the aircraft actually did.
// Pure and deterministic: the inputs are recorded snapshots and heard transmissions; nothing is issued.
// The ruling uses the same facts packet and fallback policy the sector agents use (no LLM call).
import { recentConflictingClearance } from "../../../shared/agreements.ts";
import { generateCandidates } from "../../../shared/candidates.ts";
import { angleDiff, haversineNm, sectorOf, trueToMag } from "../../../shared/geo.ts";
import { flightPhase } from "../../../shared/phase.ts";
import { clearancePhrase } from "../../../shared/phraseology.ts";
import { probeClearance } from "../../../shared/probe.ts";
import { sectorEntry } from "../../../shared/sectorEntry.ts";
import { conflictAlert } from "../../../shared/separation.ts";
import type {
  Airport,
  Clearance,
  ClearanceEval,
  ClearanceRequest,
  ConflictEval,
  EvalReport,
  HeardTransmission,
  OutcomeResult,
  Position,
  ReviewFacts,
  ShadowRuling,
} from "../../../shared/types.ts";
import { fallbackReview } from "../tools/review.ts";

export interface EvalSnapshot {
  ts: number;
  positions: Position[];
}

export interface EvalInput {
  icao: string;
  airport: Airport;
  /** Normalized, filtered snapshots sorted by ts. */
  snapshots: EvalSnapshot[];
  heard: HeardTransmission[];
  fromTs: number;
  toTs: number;
  /** Same eligibility the live conflict alert uses (IFR, corridor, CA floor). Default: all pairs. */
  caPairAllowed?: (a: Position, b: Position) => boolean;
  binMs?: number;
}

/** How long after a clearance we look for the aircraft to act on it. Real clearances take longer than our demo deadlines. */
export const OUTCOME_WINDOW_SEC = { altitude: 240, heading: 120 } as const;
const ALT_TOLERANCE_FT = 300;
const ALT_PROGRESS_FT = 500;
const HDG_TOLERANCE_DEG = 20;
const HDG_PROGRESS_DEG = 10;
const SNAPSHOT_MATCH_MS = 15_000;
const TRACK_BEFORE_SEC = 60;
const CA_LOOKAHEAD_SEC = 150;
const CA_EPISODE_GAP_MS = 60_000;
const ACTED_BEFORE_SEC = 30;

/** Transcription/parse sanity: drops speeds read as altitudes ("one eight zero") and other impossible values. */
export function plausibleClearance(req: ClearanceRequest): boolean {
  if (req.kind === "altitude") return req.value >= 1000 && req.value <= 45_000 && req.value % 100 === 0;
  return Number.isInteger(req.value) && req.value >= 1 && req.value <= 360;
}

/** Index of the last snapshot at or before ts (binary search), or -1. */
function atOrBefore(snaps: EvalSnapshot[], ts: number): number {
  let lo = 0;
  let hi = snaps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid]!.ts <= ts) (best = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return best;
}

function positionAt(snaps: EvalSnapshot[], hex: string, ts: number): { snap: EvalSnapshot; pos: Position } | null {
  const i = atOrBefore(snaps, ts);
  for (const j of [i, i + 1]) {
    const s = snaps[j];
    if (!s || Math.abs(s.ts - ts) > SNAPSHOT_MATCH_MS) continue;
    const pos = s.positions.find((p) => p.hex === hex);
    if (pos) return { snap: s, pos };
  }
  return null;
}

function trackOf(snaps: EvalSnapshot[], hex: string, from: number, to: number): Position[] {
  const out: Position[] = [];
  for (let i = Math.max(0, atOrBefore(snaps, from)); i < snaps.length && snaps[i]!.ts <= to; i++) {
    const p = snaps[i]!.positions.find((x) => x.hex === hex);
    if (p && snaps[i]!.ts >= from) out.push({ ...p, ts: snaps[i]!.ts });
  }
  return out;
}

const fmtAlt = (ft: number) => (ft >= 18_000 ? `FL${Math.round(ft / 100)}` : `${Math.round(ft).toLocaleString("en-US")}`);
const fmtHdg = (d: number) => String(Math.round(d) % 360 || 360).padStart(3, "0");

/** What the aircraft did after the clearance, judged only from recorded ADS-B. */
export function judgeOutcome(req: ClearanceRequest, ts: number, after: Position[], declinationDeg: number): ClearanceEval["outcome"] {
  const win = after.filter((p) => p.ts > ts && p.ts <= ts + OUTCOME_WINDOW_SEC[req.kind] * 1000);
  const start = after.find((p) => p.ts <= ts + 10_000) ?? after[0];
  if (!start || win.length < 3) return { result: "no_data", detail: "Not enough ADS-B after the clearance.", reachedInSec: null };
  const res = (result: OutcomeResult, detail: string, reachedInSec: number | null = null) => ({ result, detail, reachedInSec });

  if (req.kind === "altitude") {
    const a0 = start.altFt;
    if (a0 == null) return res("no_data", "No altitude reported.");
    const hit = win.find((p) => p.altFt != null && Math.abs(p.altFt - req.value) <= ALT_TOLERANCE_FT);
    if (Math.abs(a0 - req.value) <= ALT_TOLERANCE_FT) return res("complied", `Already at ${fmtAlt(a0)} and held it.`, 0);
    if (hit) return res("complied", `Reached ${fmtAlt(req.value)} in ${Math.round((hit.ts - ts) / 1000)} s.`, Math.round((hit.ts - ts) / 1000));
    const end = win[win.length - 1]!.altFt ?? a0;
    const progress = (end - a0) * Math.sign(req.value - a0);
    const span = `${fmtAlt(a0)} to ${fmtAlt(end)}`;
    if (progress >= ALT_PROGRESS_FT) return res("in_progress", `Moving toward ${fmtAlt(req.value)}: ${span}.`);
    if (progress <= -ALT_PROGRESS_FT) return res("contrary", `Moved away from ${fmtAlt(req.value)}: ${span}.`);
    return res("no_change", `Held near ${fmtAlt(a0)} (cleared ${fmtAlt(req.value)}).`);
  }

  const mag = (p: Position) => trueToMag(p.trackTrueDeg, declinationDeg);
  const off0 = Math.abs(angleDiff(mag(start), req.value));
  const hit = win.find((p) => p.ts >= ts + 5_000 && Math.abs(angleDiff(mag(p), req.value)) <= HDG_TOLERANCE_DEG);
  if (hit) return res("complied", `Tracking ${fmtHdg(mag(hit))} after ${Math.round((hit.ts - ts) / 1000)} s.`, Math.round((hit.ts - ts) / 1000));
  const offEnd = Math.abs(angleDiff(mag(win[win.length - 1]!), req.value));
  if (off0 - offEnd >= HDG_PROGRESS_DEG) return res("in_progress", `Turning toward ${fmtHdg(req.value)}: ${fmtHdg(mag(start))} to ${fmtHdg(mag(win[win.length - 1]!))}.`);
  if (offEnd - off0 >= HDG_PROGRESS_DEG) return res("contrary", `Turned away from ${fmtHdg(req.value)}.`);
  return res("no_change", `Still tracking about ${fmtHdg(mag(start))} (cleared ${fmtHdg(req.value)}).`);
}

/** Second Sight's ruling from the facts packet the sector agents get, using their deterministic policy. */
export function shadowRuling(
  pos: Position,
  req: ClearanceRequest,
  traffic: Position[],
  airport: Airport,
  prev: Clearance | null,
): ShadowRuling {
  const owner = sectorOf(pos.lat, airport);
  const candidates = generateCandidates(pos, req, traffic, airport, { goal: "cic_request", owner, now: pos.ts });
  const probe = probeClearance(pos, req, traffic, airport);
  const facts: ReviewFacts = {
    phase: flightPhase(pos, airport),
    probe: { ...probe, alternatives: candidates },
    candidates,
    brokenAgreements: [],
    recentConflict: recentConflictingClearance(prev, req, pos.altFt, pos.ts),
    sectorEntry: sectorEntry(pos, req, airport, owner),
    directives: [],
    confirmed: false,
  };
  const requested = clearancePhrase(pos.callsign, req, pos.altFt);
  const blocked = !probe.ok || !!facts.recentConflict;
  if (!blocked && facts.sectorEntry.entersOther) {
    return { decision: "coordinate", reason: `Issue after coordinating with ${facts.sectorEntry.sector ?? "the other sector"} (enters within 120 s).`, alternative: null, phase: facts.phase, conflicts: [] };
  }
  if (!blocked) return { decision: "issue", reason: "Probe clean.", alternative: null, phase: facts.phase, conflicts: [] };
  const review = fallbackReview({ ...facts, sectorEntry: { entersOther: false } }, requested);
  const alt = review.chosenCandidateId ? (candidates.find((c) => c.id === review.chosenCandidateId)?.phraseology ?? null) : null;
  return { decision: "unable", reason: review.reason.replace(/^Automatic fallback: /, ""), alternative: alt, phase: facts.phase, conflicts: probe.conflicts };
}

function evaluateClearances(input: EvalInput, heard: HeardTransmission[]): ClearanceEval[] {
  const { snapshots, airport } = input;
  const decl = airport.declinationDeg ?? 0;
  const out: ClearanceEval[] = [];
  const lastByHex = new Map<string, Clearance>();
  for (const h of heard) {
    if (h.speaker !== "controller" || !h.hex || !h.callsign) continue;
    for (const [i, req] of h.clearances.entries()) {
      if (!plausibleClearance(req)) continue;
      const at = positionAt(snapshots, h.hex, h.ts);
      const after = trackOf(snapshots, h.hex, h.ts - 10_000, h.ts + OUTCOME_WINDOW_SEC[req.kind] * 1000);
      const key = `${h.hex}:${req.kind}`;
      const prev = lastByHex.get(key) ?? null;
      let ruling: ShadowRuling | null = null;
      if (at) ruling = shadowRuling({ ...at.pos, ts: h.ts }, req, at.snap.positions, airport, prev);
      const track = trackOf(snapshots, h.hex, h.ts - TRACK_BEFORE_SEC * 1000, h.ts + OUTCOME_WINDOW_SEC.altitude * 1000).map((p) => ({
        t: Math.round((p.ts - h.ts) / 1000),
        altFt: p.altFt,
        magTrackDeg: Math.round(trueToMag(p.trackTrueDeg, decl)),
      }));
      out.push({
        id: `${h.id}#${i}`,
        ts: h.ts,
        callsign: h.callsign,
        hex: h.hex,
        text: h.text,
        req,
        before: at ? { altFt: at.pos.altFt, magTrackDeg: Math.round(trueToMag(at.pos.trackTrueDeg, decl)), vertRateFpm: Math.round(at.pos.vertRateFpm) } : null,
        outcome: at ? judgeOutcome(req, h.ts, after, decl) : { result: "no_data", detail: "Aircraft not in the ADS-B recording at that moment.", reachedInSec: null },
        ruling,
        track,
      });
      lastByHex.set(key, { ...req, issuedAt: h.ts, graceUntil: h.ts, deadlineAt: h.ts, issuedBy: "CONTROLLER", phraseology: h.text });
    }
  }
  return out;
}

function evaluateConflicts(input: EvalInput, heard: HeardTransmission[]): ConflictEval[] {
  const { snapshots, airport, fromTs, toTs } = input;
  const allowed = input.caPairAllowed ?? (() => true);
  const lastSeen = new Map<string, number>();
  const out: ConflictEval[] = [];
  for (const s of snapshots) {
    if (s.ts < fromTs || s.ts >= toTs) continue;
    const byHex = new Map(s.positions.map((p) => [p.hex, p]));
    for (const c of conflictAlert(s.positions, airport)) {
      const a = byHex.get(c.hexA);
      const b = byHex.get(c.hexB);
      if (!a || !b || !allowed(a, b)) continue;
      const key = [c.hexA, c.hexB].sort().join("/");
      const prev = lastSeen.get(key);
      lastSeen.set(key, s.ts);
      if (prev != null && s.ts - prev < CA_EPISODE_GAP_MS) continue;

      // Actual closest approach over the lookahead, from recorded positions at the same snapshot times.
      let minLat: number | null = null;
      let vertAtMin: number | null = null;
      let los = false;
      for (let i = atOrBefore(snapshots, s.ts); i >= 0 && i < snapshots.length && snapshots[i]!.ts <= s.ts + CA_LOOKAHEAD_SEC * 1000; i++) {
        const pa = snapshots[i]!.positions.find((p) => p.hex === c.hexA);
        const pb = snapshots[i]!.positions.find((p) => p.hex === c.hexB);
        if (!pa || !pb) continue;
        const lat = haversineNm(pa.lat, pa.lon, pb.lat, pb.lon);
        const vert = pa.altFt != null && pb.altFt != null ? Math.abs(pa.altFt - pb.altFt) : null;
        if (minLat == null || lat < minLat) (minLat = lat), (vertAtMin = vert);
        if (lat < 3 && vert != null && vert < 1000) los = true;
      }
      const acted = heard.find(
        (h) =>
          h.speaker === "controller" &&
          h.clearances.length > 0 &&
          (h.callsign === c.a || h.callsign === c.b) &&
          h.ts >= s.ts - ACTED_BEFORE_SEC * 1000 &&
          h.ts <= s.ts + CA_LOOKAHEAD_SEC * 1000,
      );
      out.push({
        id: `${key}@${s.ts}`,
        ts: s.ts,
        a: c.a,
        b: c.b,
        predictedInSec: c.inSec,
        predictedLatNm: Math.round(c.minLatNm * 10) / 10,
        predictedVertFt: Math.round(c.minVertFt),
        actualMinLatNm: minLat == null ? null : Math.round(minLat * 10) / 10,
        actualVertAtMinFt: vertAtMin == null ? null : Math.round(vertAtMin),
        actualLoS: los,
        controllerActed: !!acted,
        actedText: acted?.text ?? null,
        actedAfterSec: acted ? Math.round((acted.ts - s.ts) / 1000) : null,
      });
    }
  }
  return out;
}

export function evaluate(input: EvalInput): EvalReport {
  const { fromTs, toTs, snapshots } = input;
  const binMs = input.binMs ?? 5 * 60_000;
  const inRange = input.heard.filter((h) => h.ts >= fromTs && h.ts < toTs).sort((a, b) => a.ts - b.ts);
  // Earlier clearances (before the range) still count as "previous clearance" context.
  const ctx = input.heard.filter((h) => h.ts < toTs).sort((a, b) => a.ts - b.ts);
  const clearances = evaluateClearances(input, ctx).filter((c) => c.ts >= fromTs);
  const conflicts = evaluateConflicts(input, input.heard);

  const controllerClr = inRange.filter((h) => h.speaker === "controller" && h.clearances.length);
  const known = clearances.filter((c) => c.outcome.result !== "no_data");
  const ruled = clearances.filter((c) => c.ruling);
  const bins: EvalReport["bins"] = [];
  for (let t = Math.floor(fromTs / binMs) * binMs; t < toTs; t += binMs) {
    const inBin = <T extends { ts: number }>(xs: T[]) => xs.filter((x) => x.ts >= t && x.ts < t + binMs);
    bins.push({
      ts: t,
      heard: inBin(inRange).length,
      clearances: inBin(clearances).length,
      unable: inBin(clearances).filter((c) => c.ruling?.decision === "unable").length,
      conflicts: inBin(conflicts).length,
    });
  }
  const heardTs = input.heard.map((h) => h.ts);
  return {
    icao: input.icao,
    fromTs,
    toTs,
    span: {
      heardFrom: heardTs.length ? Math.min(...heardTs) : null,
      heardTo: heardTs.length ? Math.max(...heardTs) : null,
      adsbFrom: snapshots[0]?.ts ?? null,
      adsbTo: snapshots[snapshots.length - 1]?.ts ?? null,
    },
    coverage: {
      heard: inRange.length,
      controller: inRange.filter((h) => h.speaker === "controller").length,
      pilot: inRange.filter((h) => h.speaker === "pilot").length,
      unknown: inRange.filter((h) => h.speaker === "unknown").length,
      controllerClearances: controllerClr.length,
      matched: controllerClr.filter((h) => h.hex).length,
      duringAdsb: controllerClr.filter((h) => snapshots.length > 0 && h.ts >= snapshots[0]!.ts && h.ts <= snapshots[snapshots.length - 1]!.ts).length,
      implausible: controllerClr.reduce((n, h) => n + h.clearances.filter((c) => !plausibleClearance(c)).length, 0),
      withAdsb: ruled.length,
    },
    kpis: {
      complied: known.filter((c) => c.outcome.result === "complied").length,
      outcomeKnown: known.length,
      issue: ruled.filter((c) => c.ruling!.decision === "issue").length,
      coordinate: ruled.filter((c) => c.ruling!.decision === "coordinate").length,
      unable: ruled.filter((c) => c.ruling!.decision === "unable").length,
      agreed: ruled.filter((c) => c.ruling!.decision !== "unable" && c.outcome.result === "complied").length,
      conflicts: conflicts.length,
      conflictsWithLoS: conflicts.filter((c) => c.actualLoS).length,
      conflictsControllerActed: conflicts.filter((c) => c.controllerActed).length,
    },
    bins,
    clearances,
    conflicts,
  };
}
