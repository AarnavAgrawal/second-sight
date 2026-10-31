// Traffic merge for the Airspace actor (CLAUDE.md sections 7 and 8): track control assignment,
// coasting tracks, and removal of aircraft that left. Pure so it can be unit-tested without Terse.
import { sectorOf } from "./geo.ts";
import type { Airport, Position, Sector, Status, TrafficEntry } from "./types.ts";

/** A track with an active clearance that stops updating stays on the scope as `coasting` this long after its last position. */
export const COAST_DROP_MS = 60_000;

export type StatusMap = Record<string, { status: Status; reason: string }>;

export interface MergeTrafficInput {
  airport: Pick<Airport, "lat">;
  batch: Position[];
  prevTraffic: TrafficEntry[];
  trackControl: Record<string, Sector>;
  statuses: StatusMap;
  /** Hexes with a pending handoff: never assigned an owner by geometry. */
  pendingHandoffHex: Set<string>;
  /** Hexes in an open conflict alert. */
  caHex: Set<string>;
  now: number;
}

export interface MergeTrafficResult {
  traffic: TrafficEntry[];
  trackControl: Record<string, Sector>;
  statuses: StatusMap;
  /** Hexes still shown (fresh or coasting). */
  present: Set<string>;
  /** Hexes that started coasting on this merge. */
  startedCoasting: string[];
  /** Coasting hexes dropped on this merge (older than COAST_DROP_MS). */
  dropped: string[];
}

export const coastReason = (ageMs: number) => `No position for ${Math.max(0, Math.round(ageMs / 1000))} s.`;

/**
 * Merge a poll batch into the previous traffic picture.
 * - Aircraft in the batch: keep their owner, or get one by geometry unless a handoff is pending.
 * - Aircraft missing from the batch whose status is not `none` (active clearance): keep the last entry
 *   with status `coasting` and its track control, until COAST_DROP_MS after its last `ts`, then drop
 *   it along with its track control and status.
 * - Any other aircraft missing from the batch is dropped immediately.
 */
export function mergeTraffic(input: MergeTrafficInput): MergeTrafficResult {
  const { airport, batch, prevTraffic, trackControl, statuses, pendingHandoffHex, caHex, now } = input;
  const inBatch = new Set(batch.map((p) => p.hex));
  const tc: Record<string, Sector> = {};
  let nextStatuses: StatusMap = statuses;
  const startedCoasting: string[] = [];
  const dropped: string[] = [];

  const traffic: TrafficEntry[] = batch.map((p) => {
    const owner = trackControl[p.hex];
    if (owner) tc[p.hex] = owner;
    else if (!pendingHandoffHex.has(p.hex)) tc[p.hex] = sectorOf(p.lat, airport);
    return {
      hex: p.hex,
      callsign: p.callsign,
      typeCode: p.typeCode,
      lat: p.lat,
      lon: p.lon,
      altFt: p.altFt,
      vertRateFpm: p.vertRateFpm,
      gsKt: p.gsKt,
      trackTrueDeg: p.trackTrueDeg,
      status: statuses[p.hex]?.status ?? "none",
      sector: tc[p.hex] ?? null,
      ca: caHex.has(p.hex),
      ts: p.ts,
      seenSec: p.seenSec,
      isVfr: p.isVfr ?? false,
    };
  });

  for (const prev of prevTraffic) {
    if (inBatch.has(prev.hex)) continue;
    const st = statuses[prev.hex];
    if (!st || st.status === "none") continue; // no active clearance: dropped immediately
    const age = now - prev.ts;
    if (age >= COAST_DROP_MS) {
      dropped.push(prev.hex);
      if (nextStatuses === statuses) nextStatuses = { ...statuses };
      delete nextStatuses[prev.hex];
      continue;
    }
    if (st.status !== "coasting") {
      startedCoasting.push(prev.hex);
      if (nextStatuses === statuses) nextStatuses = { ...statuses };
      nextStatuses[prev.hex] = { status: "coasting", reason: coastReason(age) };
    }
    const owner = trackControl[prev.hex] ?? prev.sector ?? undefined;
    if (owner) tc[prev.hex] = owner;
    traffic.push({ ...prev, status: "coasting", sector: owner ?? null, ca: caHex.has(prev.hex) });
  }

  return {
    traffic,
    trackControl: tc,
    statuses: nextStatuses,
    present: new Set(traffic.map((t) => t.hex)),
    startedCoasting,
    dropped,
  };
}
