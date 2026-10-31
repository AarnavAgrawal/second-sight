// Separation rules, separation math and conflict alert (CLAUDE.md section 9).
// One rule function (pairRule) decides which minimum applies to a pair; the conflict alert and the clearance probe
// both use it, so they always agree. Every threshold lives in SEPARATION. Loss of separation = inside BOTH the
// lateral and the vertical minimum. Traffic already flying a clearance is projected along it (projection.ts pathFor).
import type { Airport, Position, SeparationBasis, SeparationContext } from "./types.ts";
import { haversineNm } from "./geo.ts";
import { HORIZON_SEC, STEP_SEC, pathFor, projectStraight, type PathPoint } from "./projection.ts";

// Projection primitives moved to projection.ts; re-exported so existing imports keep working.
export { HORIZON_SEC, STEP_SEC, projectStraight, straightPath, type PathPoint } from "./projection.ts";

/** Every separation threshold (FAA JO 7110.65 references on pairRule). */
export const SEPARATION = {
  /** 5-5-4: terminal radar separation, 3 NM. 4-5-1 / 5-5-5: 1,000 ft vertical. */
  standardLatNm: 3,
  standardVertFt: 1000,
  /** Both aircraft at or above this altitude use the high-altitude lateral minimum. */
  highAltitudeFt: 18_000,
  /** 5-5-4: 5 NM, the en route radar minimum used above FL180. */
  highAltitudeLatNm: 5,
  /** Mode A code for VFR. */
  vfrSquawk: "1200",
  /** 7-9-4: Class B, VFR from IFR/large aircraft: 1.5 NM lateral or 500 ft vertical. */
  vfrMixedLatNm: 1.5,
  vfrMixedVertFt: 500,
  /** Final approach suppression: both within this distance of the airport ... */
  finalRadiusNm: 12,
  /** ... below field elevation + this ... */
  finalMaxAglFt: 4000,
  /** ... descending at least this fast, and getting closer to the airport. */
  finalMinDescentFpm: 300,
  /** VFR/VFR traffic advisories: at most one per pair per this many seconds. */
  trafficInfoDebounceSec: 120,
  /** 7-2-1: visual separation is not applied in Class A (at or above 18,000 ft). */
  visualMaxAltFt: 18_000,
} as const;

export const SEP_LATERAL_NM = SEPARATION.standardLatNm;
export const SEP_VERTICAL_FT = SEPARATION.standardVertFt;

export interface Minima {
  latNm: number;
  vertFt: number;
}
export const STANDARD_MINIMA: Minima = { latNm: SEPARATION.standardLatNm, vertFt: SEPARATION.standardVertFt };

/** What a predicted loss under the pair's minima means: a conflict alert, a VFR traffic advisory, or nothing. */
export type PairAction = "conflict" | "traffic" | "none";
export interface PairRule extends Minima {
  basis: SeparationBasis;
  action: PairAction;
}

/** The minima for a basis (visual and final_suppressed have none; a VFR pair's advisory uses the VFR minima). */
export function minimaFor(basis: SeparationBasis): Minima {
  switch (basis) {
    case "high_altitude":
      return { latNm: SEPARATION.highAltitudeLatNm, vertFt: SEPARATION.standardVertFt };
    case "vfr_mixed":
    case "vfr_pair":
      return { latNm: SEPARATION.vfrMixedLatNm, vertFt: SEPARATION.vfrMixedVertFt };
    case "visual":
    case "final_suppressed":
      return { latNm: 0, vertFt: 0 };
    default:
      return STANDARD_MINIMA;
  }
}

export const BASIS_LABEL: Record<SeparationBasis, string> = {
  standard: "standard separation",
  high_altitude: `${SEPARATION.highAltitudeLatNm} NM above FL${SEPARATION.highAltitudeFt / 100}`,
  vfr_mixed: `VFR traffic, ${SEPARATION.vfrMixedLatNm} NM / ${SEPARATION.vfrMixedVertFt} ft`,
  vfr_pair: "VFR traffic advisory",
  final_suppressed: "both on final",
  visual: "visual separation",
};

/** Squawking 1200. Uses `isVfr` when set (normalizeAdsb always sets it), else the raw squawk. */
export function isVfr(p: Pick<Position, "isVfr" | "squawk">): boolean {
  return p.isVfr ?? p.squawk === SEPARATION.vfrSquawk;
}

/**
 * Established inbound on final, for final approach suppression: within 12 NM of the airport, below field
 * elevation + 4,000 ft, descending at 300 fpm or more, and getting closer to the airport along its track.
 */
export function onFinalApproach(p: Position, airport: Pick<Airport, "lat" | "lon" | "elevationFt">): boolean {
  if (p.altFt == null) return false;
  const d = haversineNm(p.lat, p.lon, airport.lat, airport.lon);
  if (d > SEPARATION.finalRadiusNm) return false;
  if (p.altFt >= airport.elevationFt + SEPARATION.finalMaxAglFt) return false;
  if (p.vertRateFpm > -SEPARATION.finalMinDescentFpm) return false;
  const ahead = projectStraight(p, STEP_SEC);
  return haversineNm(ahead.lat, ahead.lon, airport.lat, airport.lon) < d;
}

const rule = (basis: SeparationBasis, action: PairAction): PairRule => ({ ...minimaFor(basis), basis, action });

/**
 * The separation rule for a pair, from its state at t=0. First match wins:
 * 1. visual (eval only): either aircraft in ctx.visualHex and both below 18,000 ft. Visual separation (7-2-1):
 *    the pilot has the traffic in sight or was told to maintain visual separation. No alert.
 * 2. final_suppressed: both onFinalApproach. Parallel (SFO 28L/28R are 750 ft apart) and in-trail finals are
 *    separated by approach procedures and visual separation (5-9, 7-4-4), not the 3 NM minimum. No alert.
 * 3. vfr_pair: both VFR. Light VFR aircraft need only target resolution from each other in Class B (7-9-4):
 *    a predicted pass inside 1.5 NM / 500 ft is a traffic advisory (2-1-21), never a conflict alert.
 * 4. vfr_mixed: one VFR, one IFR. Class B VFR minima 1.5 NM / 500 ft (7-9-4).
 * 5. high_altitude: both at or above 18,000 ft. 5 NM / 1,000 ft (5-5-4, en route radar minimum).
 * 6. standard: 3 NM / 1,000 ft (5-5-4).
 */
export function pairRule(a: Position, b: Position, airport: Pick<Airport, "lat" | "lon" | "elevationFt">, ctx?: SeparationContext): PairRule {
  const vis = ctx?.visualHex;
  if (
    vis &&
    (vis.has(a.hex) || vis.has(b.hex)) &&
    a.altFt != null &&
    b.altFt != null &&
    a.altFt < SEPARATION.visualMaxAltFt &&
    b.altFt < SEPARATION.visualMaxAltFt
  ) {
    return rule("visual", "none");
  }
  if (onFinalApproach(a, airport) && onFinalApproach(b, airport)) return rule("final_suppressed", "none");
  const va = isVfr(a);
  const vb = isVfr(b);
  if (va && vb) return rule("vfr_pair", "traffic");
  if (va || vb) return rule("vfr_mixed", "conflict");
  if (a.altFt != null && b.altFt != null && a.altFt >= SEPARATION.highAltitudeFt && b.altFt >= SEPARATION.highAltitudeFt) {
    return rule("high_altitude", "conflict");
  }
  return rule("standard", "conflict");
}

export function lossOfSeparation(latNm: number, vertFt: number, minima: Minima = STANDARD_MINIMA): boolean {
  return latNm < minima.latNm && vertFt < minima.vertFt;
}

export interface LossResult {
  /** Time of the first sample that loses separation. */
  inSec: number;
  /** Minimum lateral distance over the whole window. */
  minLatNm: number;
  /** Minimum vertical distance over the whole window. */
  minVertFt: number;
}

/**
 * Compare two paths sampled every STEP_SEC from t=0. Returns the first loss of separation (lateral < latNm AND
 * vertical < vertFt; default standard 3 NM / 1,000 ft) and the window minimums, or null if separation holds.
 * Samples with unknown altitude are skipped.
 */
export function firstLoss(pathA: PathPoint[], pathB: PathPoint[], minima: Minima = STANDARD_MINIMA): LossResult | null {
  const n = Math.min(pathA.length, pathB.length);
  let inSec: number | null = null;
  let minLatNm = Infinity;
  let minVertFt = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pathA[i]!;
    const b = pathB[i]!;
    if (a.altFt == null || b.altFt == null) continue;
    const lat = haversineNm(a.lat, a.lon, b.lat, b.lon);
    const vert = Math.abs(a.altFt - b.altFt);
    if (lat < minLatNm) minLatNm = lat;
    if (vert < minVertFt) minVertFt = vert;
    if (inSec == null && lossOfSeparation(lat, vert, minima)) inSec = i * STEP_SEC;
  }
  if (inSec == null) return null;
  return { inSec, minLatNm, minVertFt };
}

/** A pair's predicted loss under its rule (null when the rule says no alert or separation holds). */
export function pairLoss(pathA: PathPoint[], pathB: PathPoint[], r: PairRule): LossResult | null {
  return r.action === "none" ? null : firstLoss(pathA, pathB, r);
}

export interface PredictedConflict {
  hexA: string;
  hexB: string;
  /** Callsign of aircraft A (a < b by callsign). */
  a: string;
  b: string;
  /** Seconds until the first predicted loss of separation. */
  inSec: number;
  minLatNm: number;
  minVertFt: number;
  /** Separation rule applied to the pair (pairRule). */
  basis?: SeparationBasis;
}

/**
 * Conflict alert and VFR traffic advisories: predicted loss of separation within HORIZON_SEC between any two
 * airborne aircraft, each pair under its pairRule. VFR/VFR pairs come back in `traffic`, everything else that
 * loses separation in `conflicts`. Pairs where both aircraft are below field elevation + 1,000 ft are ignored.
 * Aircraft flying a clearance (ctx.intents) are projected along it instead of straight.
 */
export function conflictAndTrafficAlerts(
  traffic: Position[],
  airport: Airport,
  ctx?: SeparationContext,
): { conflicts: PredictedConflict[]; traffic: PredictedConflict[] } {
  const lowFt = airport.elevationFt + 1000;
  const ac = traffic.filter((p) => p.altFt != null);
  const paths = ac.map((p) => pathFor(p, ctx?.intents?.get(p.hex), airport.declinationDeg));
  const maxLatNm = Math.max(SEPARATION.standardLatNm, SEPARATION.highAltitudeLatNm, SEPARATION.vfrMixedLatNm);
  const conflicts: PredictedConflict[] = [];
  const advisories: PredictedConflict[] = [];
  for (let i = 0; i < ac.length; i++) {
    for (let j = i + 1; j < ac.length; j++) {
      const p = ac[i]!;
      const q = ac[j]!;
      if (p.hex === q.hex) continue;
      if (p.altFt! < lowFt && q.altFt! < lowFt) continue;
      // Quick reject: cannot close to the largest minimum within the horizon (turns never cover more than gs * t).
      const reach = ((p.gsKt + q.gsKt) * HORIZON_SEC) / 3600 + maxLatNm;
      if (haversineNm(p.lat, p.lon, q.lat, q.lon) > reach) continue;
      const r = pairRule(p, q, airport, ctx);
      const loss = pairLoss(paths[i]!, paths[j]!, r);
      if (!loss) continue;
      const swap = p.callsign > q.callsign || (p.callsign === q.callsign && p.hex > q.hex);
      const [A, B] = swap ? [q, p] : [p, q];
      (r.action === "traffic" ? advisories : conflicts).push({
        hexA: A.hex,
        hexB: B.hex,
        a: A.callsign,
        b: B.callsign,
        inSec: loss.inSec,
        minLatNm: Math.round(loss.minLatNm * 10) / 10,
        minVertFt: Math.round(loss.minVertFt),
        basis: r.basis,
      });
    }
  }
  const byTime = (x: PredictedConflict, y: PredictedConflict) => x.inSec - y.inSec;
  return { conflicts: conflicts.sort(byTime), traffic: advisories.sort(byTime) };
}

/** Conflict alert only (VFR/VFR traffic advisories left out). See conflictAndTrafficAlerts. */
export function conflictAlert(traffic: Position[], airport: Airport, ctx?: SeparationContext): PredictedConflict[] {
  return conflictAndTrafficAlerts(traffic, airport, ctx).conflicts;
}
