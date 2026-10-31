// Standard ATC phraseology (CLAUDE.md section 2) for clearance echoes, agent messages and TTS.
import type { ClearanceRequest, ProbeResult } from "./types.ts";
import { DIGIT_WORDS, digitsIndividually, numberWords, spokenCallsign } from "./telephony.ts";
import { headingText } from "./format.ts";

/**
 * 10000 -> "one zero thousand", 8000 -> "eight thousand", 6500 -> "six thousand five hundred",
 * 12500 -> "one two thousand five hundred", 24000 -> "flight level two four zero".
 */
export function spokenAltitude(ft: number): string {
  const r = Math.round(ft / 100) * 100;
  if (r >= 18000) return `flight level ${digitsIndividually(String(Math.round(r / 100)).padStart(3, "0"))}`;
  const thousands = Math.floor(r / 1000);
  const hundreds = Math.round((r % 1000) / 100);
  const parts: string[] = [];
  if (thousands > 0) {
    parts.push(`${thousands >= 10 ? digitsIndividually(String(thousands)) : DIGIT_WORDS[thousands]} thousand`);
  }
  if (hundreds > 0 || thousands === 0) parts.push(`${DIGIT_WORDS[hundreds]} hundred`);
  return parts.join(" ");
}

/** 270 -> "two seven zero", 45 -> "zero four five", 0/360 -> "three six zero". */
export function spokenHeading(deg: number): string {
  return digitsIndividually(headingText(deg));
}

/** The clearance itself without the callsign: "climb and maintain one zero thousand". */
export function clearanceBody(req: ClearanceRequest, currentAltFt: number | null): string {
  if (req.kind === "heading") {
    return req.turn ? `turn ${req.turn} heading ${spokenHeading(req.value)}` : `fly heading ${spokenHeading(req.value)}`;
  }
  const alt = spokenAltitude(req.value);
  if (currentAltFt == null || Math.abs(req.value - currentAltFt) <= 100) return `maintain ${alt}`;
  return req.value > currentAltFt ? `climb and maintain ${alt}` : `descend and maintain ${alt}`;
}

/** "United one twenty-three, climb and maintain one zero thousand." */
export function clearancePhrase(callsign: string, req: ClearanceRequest, currentAltFt: number | null): string {
  return `${spokenCallsign(callsign)}, ${clearanceBody(req, currentAltFt)}.`;
}

function milesWords(distNm: number): string {
  const n = Math.round(distNm);
  if (n < 1) return "less than one mile";
  const w = n < 100 ? numberWords(n) : String(n);
  return n === 1 ? "one mile" : `${w} miles`;
}

/**
 * "Handoff, United one twenty-three, seven thousand eight hundred climbing to one zero thousand,
 *  three miles north of the line."
 */
export function handoffPhrase(
  callsign: string,
  altFt: number | null,
  vertRateFpm: number,
  targetAltFt: number | null,
  distNm: number,
  side: "north" | "south",
): string {
  const trend = vertRateFpm > 500 ? "climbing" : vertRateFpm < -500 ? "descending" : "level";
  let alt = altFt == null ? "altitude unknown" : `${spokenAltitude(altFt)} ${trend}`;
  if (altFt != null && targetAltFt != null && trend !== "level") alt += ` to ${spokenAltitude(targetAltFt)}`;
  return `Handoff, ${spokenCallsign(callsign)}, ${alt}, ${milesWords(distNm)} ${side} of the line.`;
}

/** "United one twenty-three, radar contact." */
export function radarContactPhrase(callsign: string): string {
  return `${spokenCallsign(callsign)}, radar contact.`;
}

/** "APREQ, Delta four fifty-six, turn left heading two seven zero for traffic United one twenty-three." */
export function apreqPhrase(
  callsign: string,
  req: ClearanceRequest,
  trafficCallsign: string,
  currentAltFt: number | null = null,
): string {
  return `APREQ, ${spokenCallsign(callsign)}, ${clearanceBody(req, currentAltFt)} for traffic ${spokenCallsign(trafficCallsign)}.`;
}

/**
 * "Unable, United one twenty-three to eight thousand, traffic Delta four fifty-six, 2.1 miles, 400 feet,
 *  in 40 seconds. Suggest seven thousand."
 */
export function unablePhrase(callsign: string, req: ClearanceRequest, probe: ProbeResult): string {
  const what = req.kind === "altitude" ? `to ${spokenAltitude(req.value)}` : `heading ${spokenHeading(req.value)}`;
  let why: string;
  const c = probe.conflicts[0];
  if (c) {
    why = `traffic ${spokenCallsign(c.with)}, ${c.minLatNm.toFixed(1)} miles, ${c.minVertFt} feet, in ${c.inSec} seconds`;
  } else {
    why = (probe.reasons[0] ?? "invalid clearance").replace(/\.$/, "").toLowerCase();
  }
  let out = `Unable, ${spokenCallsign(callsign)} ${what}, ${why}.`;
  const alt = probe.alternative;
  if (alt) {
    const sugg = alt.kind === "altitude"
      ? spokenAltitude(alt.value)
      : `${alt.turn ? `${alt.turn} ` : ""}heading ${spokenHeading(alt.value)}`;
    out += ` Suggest ${sugg}.`;
  }
  return out;
}
