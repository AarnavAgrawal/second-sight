// Conformance monitoring (CLAUDE.md section 9). Pure: decides status from a clearance and a track.
import type { Clearance, ClearanceKind, ConformanceResult, Position } from "./types.ts";
import { angleDiff, trueToMag } from "./geo.ts";
import { headingText, roundTo, withCommas } from "./format.ts";

export const ALT_TOLERANCE_FT = 300;
export const RATE_THRESHOLD_FPM = 500;
export const HEADING_TOLERANCE_DEG = 20;
export const COAST_SEC = 30;
/** Grace period after issue, in ms. */
export const GRACE = { altitude: 20000, heading: 15000 } as const;
/** Deadline after issue, in ms. */
export const DEADLINE = { altitude: 60000, heading: 45000 } as const;
/** Turning detection: positions at most this far apart, turn rate above this (deg/s). */
const TURN_WINDOW_MS = 20000;
const TURN_RATE_MIN = 1;

export function clearanceWindow(kind: ClearanceKind, issuedAt: number): { graceUntil: number; deadlineAt: number } {
  return { graceUntil: issuedAt + GRACE[kind], deadlineAt: issuedAt + DEADLINE[kind] };
}

/** 4000 -> "4,000"; 17500 -> "17,500"; 23000 -> "FL230". Rounded to 100 ft. */
export function formatAltitude(ft: number): string {
  const r = roundTo(ft, 100);
  if (r >= 18000) return "FL" + String(Math.round(r / 100)).padStart(3, "0");
  return withCommas(r);
}

const fpm = (rate: number) => withCommas(roundTo(Math.abs(rate), 100));

export function evaluateConformance(
  clearance: Clearance,
  track: Position[],
  nowMs: number,
  declinationDeg: number,
): ConformanceResult {
  const latest = track.length ? track[track.length - 1]! : null;
  if (!latest) {
    if (nowMs >= clearance.graceUntil) return { status: "coasting", reason: "No position data." };
    return { status: "pending", reason: "Awaiting position data." };
  }
  const ageSec = (nowMs - latest.ts) / 1000;
  if (ageSec > COAST_SEC) {
    return { status: "coasting", reason: `No position for ${Math.round(ageSec)} s.` };
  }
  return clearance.kind === "altitude"
    ? altitudeConformance(clearance, latest, nowMs)
    : headingConformance(clearance, track, latest, nowMs, declinationDeg);
}

function altitudeConformance(c: Clearance, p: Position, nowMs: number): ConformanceResult {
  const target = c.value;
  const head = `Cleared to ${formatAltitude(target)}.`;
  if (p.altFt == null) {
    if (nowMs >= c.deadlineAt) return { status: "non_conforming", reason: `${head} Altitude not reported.` };
    return { status: "pending", reason: `${head} Altitude not reported.` };
  }
  const now = formatAltitude(p.altFt);
  const vr = p.vertRateFpm;
  const diff = target - p.altFt;
  const verb = vr > 0 ? "climbing" : "descending";
  const moving = Math.abs(vr) > RATE_THRESHOLD_FPM;
  const rateText = moving ? `${verb} ${fpm(vr)} fpm` : "level";

  if (Math.abs(diff) <= ALT_TOLERANCE_FT) {
    return { status: "conforming", reason: `${head} Now ${now}, ${rateText}.` };
  }
  const toward = moving && Math.sign(vr) === Math.sign(diff);
  if (toward) {
    return { status: "conforming", reason: `${head} Now ${now}, ${rateText}.` };
  }
  const away = moving && !toward;
  if (nowMs < c.graceUntil) {
    return { status: "pending", reason: away ? `${head} Now ${now} and ${rateText}.` : `${head} Now ${now}, ${rateText}.` };
  }
  if (away) {
    return { status: "non_conforming", reason: `${head} Now ${now} and ${rateText}.` };
  }
  if (nowMs >= c.deadlineAt) {
    const secs = Math.round((c.deadlineAt - c.issuedAt) / 1000);
    return { status: "non_conforming", reason: `${head} Now ${now}, no change after ${secs} s.` };
  }
  return { status: "pending", reason: `${head} Now ${now}, ${rateText}.` };
}

/** Turn rate in deg/s (positive = right) from the last two positions within the turn window. */
function turnRate(track: Position[], latest: Position): number {
  for (let i = track.length - 2; i >= 0; i--) {
    const prev = track[i]!;
    const dt = (latest.ts - prev.ts) / 1000;
    if (dt <= 0) continue;
    if (dt * 1000 > TURN_WINDOW_MS) return 0;
    return angleDiff(prev.trackTrueDeg, latest.trackTrueDeg) / dt;
  }
  return 0;
}

function headingConformance(
  c: Clearance,
  track: Position[],
  latest: Position,
  nowMs: number,
  decl: number,
): ConformanceResult {
  const head = `Cleared heading ${headingText(c.value)}.`;
  const magTrack = trueToMag(latest.trackTrueDeg, decl);
  const now = `Now tracking ${headingText(magTrack)}`;
  const err = angleDiff(magTrack, c.value); // positive: cleared heading is to the right
  if (Math.abs(err) <= HEADING_TOLERANCE_DEG) {
    return { status: "conforming", reason: `${head} ${now}.` };
  }
  const rate = turnRate(track, latest);
  const turning = rate > TURN_RATE_MIN ? "right" : rate < -TURN_RATE_MIN ? "left" : null;
  const wanted = c.turn ?? (err > 0 ? "right" : "left");
  const turnText = turning ? `turning ${turning}` : "not turning";

  if (nowMs >= c.deadlineAt) {
    const secs = Math.round((c.deadlineAt - c.issuedAt) / 1000);
    const why = turning === wanted ? `still turning after ${secs} s` : turnText;
    return { status: "non_conforming", reason: `${head} ${now}, ${why}.` };
  }
  if (turning === wanted) {
    return { status: "conforming", reason: `${head} ${now}, ${turnText}.` };
  }
  if (nowMs < c.graceUntil) {
    return { status: "pending", reason: `${head} ${now}, ${turnText}.` };
  }
  return { status: "non_conforming", reason: `${head} ${now}, ${turnText}.` };
}
