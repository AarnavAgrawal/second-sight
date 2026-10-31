// Test fixtures (not exported from index.ts).
import type { Airport, Clearance, ClearanceRequest, Position } from "./types.ts";
import { destination } from "./geo.ts";
import { clearanceWindow } from "./conformance.ts";

/** KSFO-like airport with a 13 deg east declination. */
export const SFO: Airport = {
  icao: "KSFO",
  name: "San Francisco International Airport",
  city: "San Francisco",
  state: "CA",
  lat: 37.619,
  lon: -122.375,
  elevationFt: 13,
  radiusNm: 35,
  declinationDeg: 13,
};

export const T0 = 1_800_000_000_000;

export function pos(over: Partial<Position> = {}): Position {
  return {
    hex: "a00001",
    callsign: "UAL123",
    registration: null,
    typeCode: "B738",
    lat: SFO.lat + 0.3,
    lon: SFO.lon,
    altFt: 8000,
    gsKt: 250,
    trackTrueDeg: 90,
    vertRateFpm: 0,
    seenSec: 0,
    ts: T0,
    ...over,
  };
}

/** Position `distNm` from `from` along true `bearing`. */
export function offset(from: Position, bearing: number, distNm: number, over: Partial<Position> = {}): Position {
  const d = destination(from.lat, from.lon, bearing, distNm);
  return pos({ ...over, lat: d.lat, lon: d.lon });
}

export function clearance(req: ClearanceRequest, issuedAt = T0): Clearance {
  return { ...req, issuedAt, ...clearanceWindow(req.kind, issuedAt), issuedBy: "CIC", phraseology: "" };
}
