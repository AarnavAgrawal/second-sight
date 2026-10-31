// Sector entry (ai-updates.md 3e): does a clearance (or the current path) take the aircraft into the
// other sector within the 120 s projection?
import type { Airport, ClearanceRequest, Position, Sector, SectorEntry } from "./types.ts";
import { sectorOf } from "./geo.ts";
import { STEP_SEC, projectClearedPath, straightPath, type PathPoint } from "./projection.ts";

/** First projected sample (every 10 s, 0..120 s) whose sector differs from `owner`. */
export function entryFromPath(path: PathPoint[], airport: Pick<Airport, "lat">, owner: Sector): SectorEntry {
  for (let i = 0; i < path.length; i++) {
    const s = sectorOf(path[i]!.lat, airport);
    if (s !== owner) return { entersOther: true, inSec: i * STEP_SEC, sector: s };
  }
  return { entersOther: false };
}

export function sectorEntry(ac: Position, req: ClearanceRequest | null, airport: Airport, owner: Sector): SectorEntry {
  const path = req ? projectClearedPath(ac, req, airport.declinationDeg) : straightPath(ac);
  return entryFromPath(path, airport, owner);
}
