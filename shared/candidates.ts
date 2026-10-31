// Candidate generation (ai-updates.md 3a). Every candidate returned here has passed probeClearance.
// Agents pick candidates by id; they never supply their own numbers.
import type {
  Agreement,
  Airport,
  Candidate,
  CandidateGoal,
  ClearanceRequest,
  Position,
  Sector,
} from "./types.ts";
import { angleDiff, haversineNm, sectorOf, toHeading, trueToMag } from "./geo.ts";
import { roundTo } from "./format.ts";
import { probeClearance, projectClearedPath } from "./probe.ts";
import { clearancePhrase } from "./phraseology.ts";
import { checkAgreements } from "./agreements.ts";
import { entryFromPath } from "./sectorEntry.ts";

/** Fixed tag vocabulary. Agreement tags are dynamic: `breaks_agreement:<agreementId>`. */
export const CANDIDATE_TAGS: readonly string[] = [
  "keeps_climb",
  "stops_climb",
  "keeps_descent",
  "stops_descent",
  "enters_other_sector_120s",
  "toward_airport",
  "away_from_airport",
  "large_deviation",
] as const;
export const BREAKS_AGREEMENT_TAG = "breaks_agreement:";

export const CANDIDATE_ALT_STEP_FT = 1000;
export const CANDIDATE_ALT_RANGE_FT = 4000;
export const CANDIDATE_HEADING_OFFSETS = [20, -20, 40, -40, 60, -60] as const;
export const LARGE_DEVIATION_FT = 2000;
export const LARGE_DEVIATION_DEG = 40;
const VERTICAL_RATE_FPM = 500;
/** Ranking scale for mixed kinds: 50 ft of altitude counts like 1 degree of heading (2,000 ft ~ 40 deg). */
const FT_PER_DEG = LARGE_DEVIATION_FT / LARGE_DEVIATION_DEG;

/** Deviation on a common scale (degrees-equivalent), used to rank altitude and heading candidates together. */
export function candidateScore(c: Pick<Candidate, "kind" | "deviation">): number {
  return c.kind === "altitude" ? c.deviation / FT_PER_DEG : c.deviation;
}

type Option = { kind: Candidate["kind"]; value: number };

function altitudeOptions(curAlt: number | null, requested: ClearanceRequest | null, goal: CandidateGoal): number[] {
  const out: number[] = [];
  if (goal === "handoff_condition") {
    if (curAlt == null) return out;
    for (const d of [0, -1, 1, -2, 2]) out.push(curAlt + d * CANDIDATE_ALT_STEP_FT);
    return out;
  }
  if (requested?.kind === "altitude") {
    const R = requested.value;
    for (let d = CANDIDATE_ALT_STEP_FT; d <= CANDIDATE_ALT_RANGE_FT; d += CANDIDATE_ALT_STEP_FT) out.push(R - d, R + d);
    // "Stop at the present altitude" is often the natural alternative, so include it when in range.
    if (curAlt != null && Math.abs(curAlt - R) <= CANDIDATE_ALT_RANGE_FT) out.push(curAlt);
    return out;
  }
  if (curAlt == null) return out;
  out.push(curAlt); // maintain the current altitude
  for (let d = CANDIDATE_ALT_STEP_FT; d <= CANDIDATE_ALT_RANGE_FT; d += CANDIDATE_ALT_STEP_FT) out.push(curAlt - d, curAlt + d);
  return out;
}

function headingOptions(magTrack: number, requested: ClearanceRequest | null, goal: CandidateGoal): number[] {
  if (goal === "handoff_condition") return [];
  const base = requested?.kind === "heading" ? requested.value : magTrack;
  return CANDIDATE_HEADING_OFFSETS.map((d) => toHeading(base + d));
}

/**
 * Generate up to `max` (default 6) safe clearance options for an aircraft, each passing probeClearance,
 * sorted by smallest deviation from the request (ids "c1".."cN" in that order).
 * With `requested` null (resolve_conflict, handoff_condition), options are based on the current altitude
 * and magnetic track, and deviation is measured from the current state.
 */
export function generateCandidates(
  ac: Position,
  requested: ClearanceRequest | null,
  traffic: Position[],
  airport: Airport,
  opts: { goal?: CandidateGoal; agreements?: Agreement[]; owner?: Sector; now?: number; max?: number } = {},
): Candidate[] {
  const goal = opts.goal ?? (requested ? "cic_request" : "resolve_conflict");
  const max = opts.max ?? 6;
  const now = opts.now ?? ac.ts;
  const owner = opts.owner ?? sectorOf(ac.lat, airport);
  const agreements = opts.agreements ?? [];
  const curAlt = ac.altFt == null ? null : roundTo(ac.altFt, 100);
  const magTrack = trueToMag(ac.trackTrueDeg, airport.declinationDeg);
  const distNow = haversineNm(ac.lat, ac.lon, airport.lat, airport.lon);
  const climbing = ac.vertRateFpm > VERTICAL_RATE_FPM;
  const descending = ac.vertRateFpm < -VERTICAL_RATE_FPM;

  const options: Option[] = [];
  const seen = new Set<string>();
  const add = (o: Option) => {
    const key = `${o.kind}:${o.value}`;
    if (seen.has(key)) return;
    if (requested && requested.kind === o.kind && requested.value === o.value) return;
    seen.add(key);
    options.push(o);
  };
  for (const v of altitudeOptions(curAlt, requested, goal)) add({ kind: "altitude", value: v });
  for (const v of headingOptions(magTrack, requested, goal)) add({ kind: "heading", value: v });

  const out: Candidate[] = [];
  for (const o of options) {
    const req: ClearanceRequest = { kind: o.kind, value: o.value };
    if (o.kind === "heading") {
      const d = angleDiff(magTrack, o.value);
      if (Math.abs(d) >= 0.5) req.turn = d > 0 ? "right" : "left";
    }
    if (!probeClearance(ac, req, traffic, airport).ok) continue;

    let deviation: number;
    if (o.kind === "altitude") {
      const ref = requested?.kind === "altitude" ? requested.value : curAlt;
      deviation = ref == null ? 0 : Math.abs(o.value - ref);
    } else {
      const ref = requested?.kind === "heading" ? requested.value : magTrack;
      deviation = Math.round(Math.abs(angleDiff(ref, o.value)));
    }

    const tags: string[] = [];
    if (climbing) {
      const keeps = o.kind === "heading" || (ac.altFt != null && o.value >= ac.altFt + CANDIDATE_ALT_STEP_FT);
      tags.push(keeps ? "keeps_climb" : "stops_climb");
    } else if (descending) {
      const keeps = o.kind === "heading" || (ac.altFt != null && o.value <= ac.altFt - CANDIDATE_ALT_STEP_FT);
      tags.push(keeps ? "keeps_descent" : "stops_descent");
    }
    const path = projectClearedPath(ac, req, airport.declinationDeg);
    if (entryFromPath(path, airport, owner).entersOther) tags.push("enters_other_sector_120s");
    for (const a of checkAgreements(ac.hex, req, agreements, now)) tags.push(`${BREAKS_AGREEMENT_TAG}${a.id}`);
    const end = path[path.length - 1]!;
    tags.push(haversineNm(end.lat, end.lon, airport.lat, airport.lon) < distNow ? "toward_airport" : "away_from_airport");
    if (deviation > (o.kind === "altitude" ? LARGE_DEVIATION_FT : LARGE_DEVIATION_DEG)) tags.push("large_deviation");

    out.push({
      id: "",
      ...req,
      phraseology: clearancePhrase(ac.callsign, req, ac.altFt),
      deviation,
      tags,
    });
  }

  const sameKind = (c: Candidate) => (requested && c.kind === requested.kind ? 0 : 1);
  out.sort(
    (a, b) =>
      candidateScore(a) - candidateScore(b) ||
      sameKind(a) - sameKind(b) ||
      (a.kind === b.kind ? 0 : a.kind === "altitude" ? -1 : 1) ||
      a.value - b.value,
  );
  return out.slice(0, Math.max(0, max)).map((c, i) => ({ ...c, id: `c${i + 1}` }));
}
