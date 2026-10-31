// Boundary approach detection (CLAUDE.md section 9).
import type { Airport, Position, Sector } from "./types.ts";
import { distToBoundaryNm, sectorOf } from "./geo.ts";
import { projectStraight } from "./projection.ts";

export const BOUNDARY_LOOKAHEAD_SEC = 90;
export const BOUNDARY_NEAR_NM = 4;

/**
 * If the aircraft, projected 90 s ahead, ends up in the other sector and is now within 4 NM
 * of the sector boundary, return the crossing. Callers emit BOUNDARY once per aircraft per crossing.
 */
export function boundaryApproach(
  p: Position,
  airport: Airport,
  owner: Sector,
): { from: Sector; to: Sector; distNm: number } | null {
  const ahead = projectStraight(p, BOUNDARY_LOOKAHEAD_SEC);
  const to = sectorOf(ahead.lat, airport);
  if (to === owner) return null;
  const dist = distToBoundaryNm(p.lat, airport);
  if (dist > BOUNDARY_NEAR_NM) return null;
  return { from: owner, to, distNm: Math.round(dist * 10) / 10 };
}
