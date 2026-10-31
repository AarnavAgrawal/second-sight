// Geometry helpers. Distances in nautical miles, angles in degrees.
import type { Airport, Sector } from "./types.ts";

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point reached from (lat, lon) travelling distNm along a true bearing. */
export function destination(lat: number, lon: number, bearingDeg: number, distNm: number): { lat: number; lon: number } {
  const d = distNm / R_NM;
  const b = toRad(bearingDeg);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Normalize to [0, 360). */
export function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Normalize to a heading in 1..360 (ATC style: north is 360). */
export function toHeading(d: number): number {
  const h = Math.round(norm360(d));
  return h === 0 ? 360 : h;
}

/** Signed smallest angle from `from` to `to`, in (-180, 180]. Positive = clockwise (right). */
export function angleDiff(from: number, to: number): number {
  let d = norm360(to - from);
  if (d > 180) d -= 360;
  return d;
}

/** Magnetic = true - east declination. */
export const trueToMag = (trueDeg: number, declEastDeg: number) => norm360(trueDeg - declEastDeg);
export const magToTrue = (magDeg: number, declEastDeg: number) => norm360(magDeg + declEastDeg);

/** Sector boundary is the east-west line (latitude) through the airport. */
export function sectorOf(lat: number, airport: Pick<Airport, "lat">): Sector {
  return lat >= airport.lat ? "NORTH" : "SOUTH";
}

/** Distance in NM from a point to the sector boundary (latitude line through the airport). */
export function distToBoundaryNm(lat: number, airport: Pick<Airport, "lat">): number {
  return Math.abs(lat - airport.lat) * 60;
}
