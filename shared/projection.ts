// Trajectory projection (CLAUDE.md section 9): straight-line, cleared-clearance profile, and paths for traffic
// that is already flying a clearance (intents). Bottom layer of the separation math: imports only geo and types,
// so phase.ts, separation.ts and probe.ts can all build on it without import cycles.
import type { ClearanceKind, ClearanceRequest, Intent, Position, SeparationContext, Turn } from "./types.ts";
import { angleDiff, destination, magToTrue, norm360, trueToMag } from "./geo.ts";

export const HORIZON_SEC = 120;
export const STEP_SEC = 10;
export const MIN_PROBE_RATE_FPM = 1500;
export const TURN_RATE_DEG_PER_SEC = 3;

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

/**
 * Model the cleared aircraft's new profile, sampled every STEP_SEC from 0 to HORIZON_SEC.
 * Altitude: climb/descend at max(|current rate|, 1,500 fpm) toward the cleared altitude, then level;
 * lateral path straight. Heading (magnetic): converted to true, standard-rate turn (3 deg/s) in the
 * cleared direction (or the shorter way), then straight; vertical rate unchanged.
 */
export function projectClearedPath(p: Position, req: ClearanceRequest, declinationDeg: number): PathPoint[] {
  const out: PathPoint[] = [];
  if (req.kind === "altitude") {
    const rate = Math.max(Math.abs(p.vertRateFpm), MIN_PROBE_RATE_FPM);
    for (let t = 0; t <= HORIZON_SEC; t += STEP_SEC) {
      const distNm = (p.gsKt * t) / 3600;
      const d = distNm > 0 ? destination(p.lat, p.lon, p.trackTrueDeg, distNm) : { lat: p.lat, lon: p.lon };
      let altFt: number | null = null;
      if (p.altFt != null) {
        const diff = req.value - p.altFt;
        const change = Math.min(Math.abs(diff), (rate * t) / 60);
        altFt = p.altFt + Math.sign(diff) * change;
      }
      out.push({ lat: d.lat, lon: d.lon, altFt });
    }
    return out;
  }

  // Heading clearance: integrate in 1 s steps.
  const targetTrue = magToTrue(req.value, declinationDeg);
  let dir: number;
  let total: number;
  if (req.turn === "right") {
    dir = 1;
    total = norm360(targetTrue - p.trackTrueDeg);
  } else if (req.turn === "left") {
    dir = -1;
    total = norm360(p.trackTrueDeg - targetTrue);
  } else {
    const d = angleDiff(p.trackTrueDeg, targetTrue);
    dir = Math.sign(d);
    total = Math.abs(d);
  }
  let lat = p.lat;
  let lon = p.lon;
  let hdg = p.trackTrueDeg;
  let turned = 0;
  const stepNm = p.gsKt / 3600;
  const altAt = (t: number) => (p.altFt == null ? null : p.altFt + (p.vertRateFpm * t) / 60);
  out.push({ lat, lon, altFt: altAt(0) });
  for (let t = 1; t <= HORIZON_SEC; t++) {
    const step = Math.min(TURN_RATE_DEG_PER_SEC, total - turned);
    const before = hdg;
    if (step > 0) {
      turned += step;
      hdg = norm360(hdg + dir * step);
    }
    // Fly the average heading over this second.
    const mid = norm360(before + (dir * Math.max(step, 0)) / 2);
    if (stepNm > 0) {
      const d = destination(lat, lon, mid, stepNm);
      lat = d.lat;
      lon = d.lon;
    }
    if (t % STEP_SEC === 0) out.push({ lat, lon, altFt: altAt(t) });
  }
  return out;
}

/** Lateral samples from one path with altitudes from another (same sampling). */
export function mergePaths(lateral: PathPoint[], vertical: PathPoint[]): PathPoint[] {
  return lateral.map((p, i) => ({ lat: p.lat, lon: p.lon, altFt: vertical[i]?.altFt ?? p.altFt }));
}

/** Within this many degrees of an assigned heading, an aircraft already flying it is assumed to finish the short way. */
export const INTENT_SETTLED_DEG = 30;

/**
 * Path for traffic that is flying a clearance it already received (an intent):
 * - no intent: straight line;
 * - heading intent: the heading turn model of projectClearedPath (when the aircraft is already within 30 degrees
 *   of the heading, the stated turn direction is dropped so a small overshoot doesn't become a 330 degree turn);
 * - altitude intent: the vertical profile of projectClearedPath toward the cleared altitude;
 * - both: lateral from the heading path, altitude from the altitude path.
 */
export function pathFor(p: Position, intent: Intent | undefined, declinationDeg: number): PathPoint[] {
  const alt = intent?.altitude;
  let hdg = intent?.heading;
  if (hdg?.turn && Math.abs(angleDiff(trueToMag(p.trackTrueDeg, declinationDeg), hdg.value)) <= INTENT_SETTLED_DEG) {
    hdg = { kind: "heading", value: hdg.value };
  }
  if (!alt && !hdg) return straightPath(p);
  if (hdg && !alt) return projectClearedPath(p, hdg, declinationDeg);
  if (alt && !hdg) return projectClearedPath(p, alt, declinationDeg);
  return mergePaths(projectClearedPath(p, hdg!, declinationDeg), projectClearedPath(p, alt!, declinationDeg));
}

export const INTENT_WINDOW_SEC = 120;

/**
 * Clearances in progress from a clearance log: the latest entry per aircraft per kind with
 * now - windowSec <= ts <= now. Older clearances are assumed flown (the aircraft is projected straight again).
 */
export function intentsFromLog(
  log: { hex: string; kind: ClearanceKind; value: number; turn?: Turn; ts: number }[],
  now: number,
  windowSec = INTENT_WINDOW_SEC,
): Map<string, Intent> {
  const from = now - windowSec * 1000;
  const latest = new Map<string, Map<ClearanceKind, { ts: number; req: ClearanceRequest }>>();
  for (const e of log) {
    if (e.ts < from || e.ts > now) continue;
    let byKind = latest.get(e.hex);
    if (!byKind) latest.set(e.hex, (byKind = new Map()));
    const prev = byKind.get(e.kind);
    if (prev && prev.ts > e.ts) continue;
    byKind.set(e.kind, { ts: e.ts, req: { kind: e.kind, value: e.value, ...(e.turn ? { turn: e.turn } : {}) } });
  }
  const out = new Map<string, Intent>();
  for (const [hex, byKind] of latest) {
    const intent: Intent = {};
    const a = byKind.get("altitude");
    const h = byKind.get("heading");
    if (a) intent.altitude = a.req;
    if (h) intent.heading = h.req;
    out.set(hex, intent);
  }
  return out;
}

/**
 * Separation context for the live system, from the Airspace actor's clearance log: aircraft that received a
 * clearance in the last 120 s are projected along it. Aircraft that are non_conforming (not flying it: the real
 * aircraft never hear our clearances) or coasting are projected straight. `visualHex` stays empty: the live
 * system does not hear pilots, so it never assumes visual separation.
 */
export function liveSeparationContext(
  clearanceLog: { hex: string; kind: ClearanceKind; value: number; turn?: Turn; ts: number }[],
  statuses: Record<string, { status: string }> | undefined,
  now: number,
): SeparationContext {
  const intents = intentsFromLog(clearanceLog, now);
  for (const hex of [...intents.keys()]) {
    const st = statuses?.[hex]?.status;
    if (st === "non_conforming" || st === "coasting") intents.delete(hex);
  }
  return { intents, visualHex: new Set() };
}
