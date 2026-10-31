// Clearance probe (CLAUDE.md section 9): validity, simplified floor, conflict probe, alternative.
// The conflict probe uses the same pair rule as the conflict alert (separation.ts pairRule), so a clearance the
// probe passes never immediately raises a CA, and vice versa.
import type { Airport, ClearanceRequest, Position, ProbeConflict, ProbeResult, SeparationContext } from "./types.ts";
import { norm360, toHeading } from "./geo.ts";
import { mergePaths, pathFor, projectClearedPath, type PathPoint } from "./projection.ts";
import { BASIS_LABEL, pairLoss, pairRule } from "./separation.ts";

// Moved to projection.ts; re-exported so existing imports keep working.
export { MIN_PROBE_RATE_FPM, TURN_RATE_DEG_PER_SEC, projectClearedPath } from "./projection.ts";

export const MAX_ALTITUDE_FT = 45000;

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
 * The probed aircraft's path: the requested clearance, combined with the other kind of clearance it is already
 * flying (ctx.intents), if any. Without an intent this is exactly projectClearedPath.
 */
function probedPath(ac: Position, req: ClearanceRequest, airport: Airport, ctx?: SeparationContext): PathPoint[] {
  const own = ctx?.intents?.get(ac.hex);
  const requested = projectClearedPath(ac, req, airport.declinationDeg);
  if (req.kind === "altitude" && own?.heading) return mergePaths(pathFor(ac, { heading: own.heading }, airport.declinationDeg), requested);
  if (req.kind === "heading" && own?.altitude) return mergePaths(requested, pathFor(ac, { altitude: own.altitude }, airport.declinationDeg));
  return requested;
}

function conflictsFor(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport, ctx?: SeparationContext): ProbeConflict[] {
  const path = probedPath(ac, req, airport, ctx);
  const out: ProbeConflict[] = [];
  for (const other of traffic) {
    if (other.hex === ac.hex || other.altFt == null) continue;
    const r = pairRule(ac, other, airport, ctx);
    // VFR/VFR pairs never fail the probe (traffic advisory only); visual and final-suppressed pairs have no minimum.
    if (r.action !== "conflict") continue;
    const loss = pairLoss(path, pathFor(other, ctx?.intents?.get(other.hex), airport.declinationDeg), r);
    if (!loss) continue;
    out.push({
      with: other.callsign,
      withHex: other.hex,
      minLatNm: Math.round(loss.minLatNm * 10) / 10,
      minVertFt: Math.round(loss.minVertFt / 100) * 100,
      inSec: loss.inSec,
      basis: r.basis,
    });
  }
  return out.sort((a, b) => a.inSec - b.inSec);
}

function probeCore(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport, ctx?: SeparationContext): ProbeResult {
  const reasons = validateClearance(req, airport);
  const conflicts = reasons.length === 0 ? conflictsFor(ac, req, traffic, airport, ctx) : [];
  for (const c of conflicts) {
    const basis = c.basis && c.basis !== "standard" ? ` (${BASIS_LABEL[c.basis]})` : "";
    reasons.push(`Traffic ${c.with}, ${c.minLatNm.toFixed(1)} NM, ${c.minVertFt} ft, in ${c.inSec} s${basis}.`);
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
 * Each pair uses separation.ts pairRule (the same rules as the conflict alert). With a context, traffic flying a
 * clearance (ctx.intents) is projected along it, and ctx.visualHex marks visual separation.
 */
export function probeClearance(ac: Position, req: ClearanceRequest, traffic: Position[], airport: Airport, ctx?: SeparationContext): ProbeResult {
  const result = probeCore(ac, req, traffic, airport, ctx);
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
    if (probeCore(ac, alt, traffic, airport, ctx).ok) {
      result.alternative = alt;
      break;
    }
  }
  return result;
}
