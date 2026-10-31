// ADS-B normalizer: readsb-style JSON (adsb.lol /v2) -> Position[].
import type { Airport, Position } from "./types.ts";

export interface RawAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground" | string;
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  seen?: number;
  seen_pos?: number;
  [k: string]: unknown;
}

export interface RawAdsb {
  ac?: RawAircraft[];
  now?: number;
  [k: string]: unknown;
}

export const MAX_SEEN_SEC = 30;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Normalize a raw snapshot. Drops aircraft with no position, on the ground or without barometric
 * altitude, below field elevation + 1,000 ft, or not seen for more than 30 s.
 */
export function normalizeAdsb(raw: unknown, airport: Airport, nowMs: number): Position[] {
  const list = (raw as RawAdsb | null)?.ac;
  if (!Array.isArray(list)) return [];
  const minAlt = airport.elevationFt + 1000;
  const out: Position[] = [];
  const seenHex = new Set<string>();
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const hexRaw = str(a.hex);
    const lat = num(a.lat);
    const lon = num(a.lon);
    const alt = num(a.alt_baro);
    if (!hexRaw || lat == null || lon == null || alt == null) continue;
    if (alt < minAlt) continue;
    const seen = num(a.seen) ?? 0;
    const seenPos = num(a.seen_pos) ?? seen;
    if (seen > MAX_SEEN_SEC || seenPos > MAX_SEEN_SEC) continue;
    const hex = hexRaw.toLowerCase();
    if (seenHex.has(hex)) continue;
    seenHex.add(hex);
    const registration = str(a.r);
    out.push({
      hex,
      callsign: (str(a.flight) ?? registration ?? hexRaw).toUpperCase(),
      registration,
      typeCode: str(a.t),
      lat,
      lon,
      altFt: alt,
      gsKt: num(a.gs) ?? 0,
      trackTrueDeg: num(a.track) ?? num(a.true_heading) ?? 0,
      vertRateFpm: num(a.baro_rate) ?? num(a.geom_rate) ?? 0,
      seenSec: seen,
      ts: Math.round(nowMs - seenPos * 1000),
    });
  }
  return out;
}
