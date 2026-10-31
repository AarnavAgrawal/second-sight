// Clearance probe (CLAUDE.md section 9): validity, simplified floor, conflict probe, alternative.
import type { Airport, ClearanceRequest, Position, ProbeConflict, ProbeResult } from "./types.ts";
import { angleDiff, destination, magToTrue, norm360, toHeading } from "./geo.ts";
import { HORIZON_SEC, STEP_SEC, firstLoss, straightPath, type PathPoint } from "./separation.ts";

export const MAX_ALTITUDE_FT = 45000;
export const MIN_PROBE_RATE_FPM = 1500;
export const TURN_RATE_DEG_PER_SEC = 3;

/** Simplified minimum altitude floor: field elevation + 1,500 ft, rounded up to the next 100 ft. */
export function simplifiedFloorFt(airport: Pick<Airport, "elevationFt">): number {
  return Math.ceil((airport.elevationFt + 1500) / 100) * 100;
}

export function validateClearance(req: ClearanceRequest, airport: Airport): string[] {
  const reasons: string[] = [];
  const v = req.value;
  if (req.kind === "heading") {
    if (!Number.isInteger(v) || v < 1 || v > 360) reasons.push("Heading must be 001 to 360.");
  } else if (req.kind === "altitude") {
    if (!Number.isFinite(v)) {
      reasons.push("Altitude is not a number.");
      return reasons;
    }
    if (!Number.isInteger(v) || v % 100 !== 0) reasons.push("Altitude must be in 100 ft steps.");
    if (v < simplifiedFloorFt(airport)) reasons.push("Below simplified minimum altitude floor.");
    if (v > MAX_ALTITUDE_FT) reasons.push("Above FL450.");
  } else {
    reasons.push("Unknown clearance kind.");
  }
  return reasons;
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

function conflictsFor(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport): ProbeConflict[] {
  const path = projectClearedPath(ac, req, airport.declinationDeg);
  const out: ProbeConflict[] = [];
  for (const other of traffic) {
    if (other.hex === ac.hex || other.altFt == null) continue;
    const loss = firstLoss(path, straightPath(other));
    if (!loss) continue;
    out.push({
      with: other.callsign,
      minLatNm: Math.round(loss.minLatNm * 10) / 10,
      minVertFt: Math.round(loss.minVertFt / 100) * 100,
      inSec: loss.inSec,
    });
  }
  return out.sort((a, b) => a.inSec - b.inSec);
}

function probeCore(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport): ProbeResult {
  const reasons = validateClearance(req, airport);
  const conflicts = reasons.length === 0 ? conflictsFor(ac, req, traffic, airport) : [];
  for (const c of conflicts) {
    reasons.push(`Traffic ${c.with}, ${c.minLatNm.toFixed(1)} NM, ${c.minVertFt} ft, in ${c.inSec} s.`);
  }
  return { ok: reasons.length === 0, reasons, conflicts };
}

function altitudeCandidates(ac: Position, req: ClearanceRequest): number[] {
  if (ac.altFt == null) return [];
  const current = Math.round(ac.altFt / 100) * 100;
  const R = req.value;
  if (current === R) return [];
  const step = current > R ? 1000 : -1000;
  const out: number[] = [];
  for (let v = R + step; step > 0 ? v < current : v > current; v += step) out.push(v);
  out.push(current);
  return out;
}

function headingCandidates(req: ClearanceRequest): number[] {
  return [20, -20, 40, -40].map((d) => toHeading(req.value + d));
}

/**
 * Probe a proposed clearance against current traffic (which may include the aircraft itself).
 * ok = no reasons. When not ok, `alternative` is the first nearby clearance that passes.
 */
export function probeClearance(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport): ProbeResult {
  const result = probeCore(ac, req, traffic, airport);
  if (result.ok) return result;
  if (!Number.isFinite(req.value)) return result;
  const candidates = req.kind === "altitude" ? altitudeCandidates(ac, req) : headingCandidates(req);
  const magTrack = norm360(ac.trackTrueDeg - airport.declinationDeg);
  for (const value of candidates) {
    const alt: ClearanceRequest = { kind: req.kind, value };
    if (req.kind === "heading" && req.turn) {
      // Keep the cleared turn direction, but never suggest a turn of more than 180 degrees.
      const amount = req.turn === "right" ? norm360(value - magTrack) : norm360(magTrack - value);
      if (amount > 180) continue;
      alt.turn = req.turn;
    }
    if (probeCore(ac, alt, traffic, airport).ok) {
      result.alternative = alt;
      break;
    }
  }
  return result;
}
