// Pure terminal-area filters used by the poller (conflict alert eligibility, shadow targets, handoff retry).
// No I/O and no config reads: everything comes in as arguments so it can be unit-tested.
import { haversineNm } from "../../shared/geo.ts";
import type { Airport, Position, Sector } from "../../shared/types.ts";

/** A failed handoff (overdue or unable) may re-emit BOUNDARY once, this long after its dueAt. */
export const HANDOFF_RETRY_AFTER_MS = 30_000;

/** Drop TIS-B/ADS-R shadow targets (non-ICAO "~" hex) that duplicate a real ICAO target. */
export function dropShadows(positions: Position[]): Position[] {
  const real = positions.filter((p) => !p.hex.startsWith("~"));
  return positions.filter(
    (p) =>
      !p.hex.startsWith("~") ||
      !real.some((r) => haversineNm(p.lat, p.lon, r.lat, r.lon) < 0.5 && Math.abs((p.altFt ?? 0) - (r.altFt ?? 0)) < 300),
  );
}

/**
 * Hexes (lowercase) with a known, non-VFR squawk. Terminal conflict alert and handoffs are for tracked
 * IFR traffic: VFR (1200) and targets with no squawk (TIS-B/unknown) are left out.
 */
export function discreteSquawkSet(rawAc: Record<string, unknown>[]): Set<string> {
  return new Set(
    rawAc
      .filter((a) => a.squawk != null && String(a.squawk) !== "1200" && a.hex != null)
      .map((a) => String(a.hex).toLowerCase()),
  );
}

/**
 * Hexes (lowercase) with any squawk, VFR 1200 included. Conflict alert / traffic advisory eligibility: the shared
 * pair rule (shared/separation.ts) needs VFR targets for VFR/VFR traffic advisories and VFR/IFR minima.
 * Targets with no squawk (TIS-B/unknown) stay out.
 */
export function squawkSet(rawAc: Record<string, unknown>[]): Set<string> {
  return new Set(
    rawAc
      .filter((a) => a.squawk != null && String(a.squawk).trim() !== "" && a.hex != null)
      .map((a) => String(a.hex).toLowerCase()),
  );
}

/**
 * Whether a predicted conflict (or VFR traffic advisory) between `a` and `b` should be raised.
 * - With a replay focus set, at least one aircraft must be a focus callsign.
 * - Both below the CA floor (field elevation + caFloorAglFt): low-level GA, not alerted.
 * Aircraft established on final are handled by the shared pair rule (final approach suppression), not here.
 */
export function caPairAllowed(
  a: Position,
  b: Position,
  airport: Pick<Airport, "lat" | "lon" | "elevationFt">,
  caFloorAglFt: number,
  focus: Set<string> | null = null,
): boolean {
  if (focus && !focus.has(a.callsign) && !focus.has(b.callsign)) return false;
  const floor = airport.elevationFt + caFloorAglFt;
  return !((a.altFt ?? 0) < floor && (b.altFt ?? 0) < floor);
}

export interface HandoffLike {
  hex: string;
  from: Sector;
  state: "pending" | "accepted" | "unable" | "overdue" | string;
  dueAt: number;
}

/**
 * BOUNDARY emission gate for one aircraft (geometry is checked separately with boundaryApproach).
 * - "emit": first BOUNDARY for this owner.
 * - "retry": the owner's last handoff ended overdue or unable, it is now at least 30 s past dueAt,
 *   and no retry was sent yet for this owner. Exactly one retry per aircraft per owner.
 * - "skip": otherwise (a handoff is pending, already emitted, waiting for the retry time, or already retried).
 * `handoff` is the most recent handoff record for this hex, if any.
 */
export function boundaryGate(args: {
  owner: Sector;
  emitted: boolean;
  retried: boolean;
  handoff: HandoffLike | undefined;
  now: number;
}): "emit" | "retry" | "skip" {
  const { owner, emitted, retried, handoff, now } = args;
  if (handoff?.state === "pending") return "skip";
  const failed = handoff && (handoff.state === "overdue" || handoff.state === "unable");
  if (failed && handoff.from === owner) {
    if (retried || now < handoff.dueAt + HANDOFF_RETRY_AFTER_MS) return "skip";
    return "retry";
  }
  // An overdue handoff from another owner is still open (it can be accepted late): don't start a new one.
  if (handoff?.state === "overdue") return "skip";
  return emitted ? "skip" : "emit";
}

/** Most recent handoff per hex (later entries win; the actor appends in time order). */
export function latestHandoffByHex<H extends { hex: string }>(handoffs: H[]): Map<string, H> {
  const m = new Map<string, H>();
  for (const h of handoffs) m.set(h.hex, h);
  return m;
}
