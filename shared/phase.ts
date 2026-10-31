// Estimated flight phase (ai-updates.md 3b). A heuristic from position and vertical rate, not a flight plan.
import type { Airport, FlightPhase, Position } from "./types.ts";
import { haversineNm } from "./geo.ts";
import { projectStraight } from "./separation.ts";

export const DEPARTURE_RADIUS_NM = 25;
export const ARRIVAL_RADIUS_NM = 40;
export const PHASE_RATE_FPM = 500;
const LOOKAHEAD_SEC = 30;

export function flightPhase(ac: Position, airport: Airport): FlightPhase {
  const now = haversineNm(ac.lat, ac.lon, airport.lat, airport.lon);
  const ahead = projectStraight(ac, LOOKAHEAD_SEC);
  const later = haversineNm(ahead.lat, ahead.lon, airport.lat, airport.lon);
  if (now <= DEPARTURE_RADIUS_NM && ac.vertRateFpm >= PHASE_RATE_FPM && later > now) return "departure";
  if (now <= ARRIVAL_RADIUS_NM && ac.vertRateFpm <= -PHASE_RATE_FPM && later < now) return "arrival";
  return "overflight";
}
