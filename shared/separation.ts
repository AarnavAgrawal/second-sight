// Separation math and conflict alert (CLAUDE.md section 9).
// Standard separation: 3 NM lateral or 1,000 ft vertical. Loss of separation = inside BOTH.
import type { Airport, Position } from "./types.ts";
import { destination, haversineNm } from "./geo.ts";

export const SEP_LATERAL_NM = 3;
export const SEP_VERTICAL_FT = 1000;
export const HORIZON_SEC = 120;
export const STEP_SEC = 10;

export interface PathPoint {
  lat: number;
  lon: number;
  altFt: number | null;
}

/** Straight-line projection from ground speed, true track and vertical rate. */
export function projectStraight(p: Position, tSec: number): PathPoint {
  const distNm = (p.gsKt * tSec) / 3600;
  const d = distNm > 0 ? destination(p.lat, p.lon, p.trackTrueDeg, distNm) : { lat: p.lat, lon: p.lon };
  const altFt = p.altFt == null ? null : p.altFt + (p.vertRateFpm * tSec) / 60;
  return { lat: d.lat, lon: d.lon, altFt };
}

/** Straight projection sampled every STEP_SEC from t=0 to HORIZON_SEC inclusive. */
export function straightPath(p: Position): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = 0; t <= HORIZON_SEC; t += STEP_SEC) out.push(projectStraight(p, t));
  return out;
}

export function lossOfSeparation(latNm: number, vertFt: number): boolean {
  return latNm < SEP_LATERAL_NM && vertFt < SEP_VERTICAL_FT;
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
 * Compare two paths sampled every STEP_SEC from t=0. Returns the first loss of separation
 * (and the window minimums), or null if separation holds. Samples with unknown altitude are skipped.
 */
export function firstLoss(pathA: PathPoint[], pathB: PathPoint[]): LossResult | null {
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
    if (inSec == null && lossOfSeparation(lat, vert)) inSec = i * STEP_SEC;
  }
  if (inSec == null) return null;
  return { inSec, minLatNm, minVertFt };
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
}

/**
 * Conflict alert: predicted loss of separation within HORIZON_SEC between any two airborne aircraft.
 * Pairs where both aircraft are below field elevation + 1,000 ft are ignored (parallel approaches).
 */
export function conflictAlert(traffic: Position[], airport: Airport): PredictedConflict[] {
  const lowFt = airport.elevationFt + 1000;
  const ac = traffic.filter((p) => p.altFt != null);
  const paths = ac.map(straightPath);
  const out: PredictedConflict[] = [];
  for (let i = 0; i < ac.length; i++) {
    for (let j = i + 1; j < ac.length; j++) {
      const p = ac[i]!;
      const q = ac[j]!;
      if (p.hex === q.hex) continue;
      if (p.altFt! < lowFt && q.altFt! < lowFt) continue;
      // Quick reject: cannot close to 3 NM within the horizon.
      const reach = ((p.gsKt + q.gsKt) * HORIZON_SEC) / 3600 + SEP_LATERAL_NM;
      if (haversineNm(p.lat, p.lon, q.lat, q.lon) > reach) continue;
      const loss = firstLoss(paths[i]!, paths[j]!);
      if (!loss) continue;
      const swap = p.callsign > q.callsign || (p.callsign === q.callsign && p.hex > q.hex);
      const [A, B] = swap ? [q, p] : [p, q];
      out.push({
        hexA: A.hex,
        hexB: B.hex,
        a: A.callsign,
        b: B.callsign,
        inSec: loss.inSec,
        minLatNm: Math.round(loss.minLatNm * 10) / 10,
        minVertFt: Math.round(loss.minVertFt),
      });
    }
  }
  return out.sort((x, y) => x.inSec - y.inSec);
}
