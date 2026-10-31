// Deterministic callsign matching for transcribed radio transmissions (evaluation data).
// Finds "Southwest thirty-six eighty-six" / "American 271" / abbreviated "six six eight" / "Four Kilo Bravo"
// among the callsigns on radar. Only returns a match when it is unambiguous.
import { PHONETIC, TELEPHONY } from "./telephony.ts";

export type MatchMethod = "airline" | "airline_fuzzy" | "number" | "n_number";
export interface CallsignMatch {
  callsign: string;
  method: MatchMethod;
}

const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const LETTER: Record<string, string> = Object.fromEntries(Object.entries(PHONETIC).map(([k, v]) => [v.replace("-", ""), k]));
// Words that end a callsign: what follows is the clearance, not more of the flight number.
const STOP = new Set(["heavy", "super", "turn", "climb", "descend", "maintain", "heading", "contact", "cleared", "reduce", "fly", "expect", "traffic", "left", "right"]);

/** Lowercase, split hyphens and punctuation, and join two-word airline names the transcriber splits. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/south west/g, "southwest")
    .replace(/sky west/g, "skywest")
    .replace(/jet blue/g, "jetblue")
    .replace(/fed ex/g, "fedex")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Read a run of number tokens starting at i as a flight number in group form:
 * "thirty six eighty six" -> "3686", "twenty seven zero three" -> "2703", "three seventy three" -> "373", "271" -> "271".
 */
export function readNumber(tok: string[], i: number): { digits: string; end: number } | null {
  let digits = "";
  let j = i;
  while (j < tok.length && digits.length < 5) {
    const w = tok[j]!;
    if (/^\d+$/.test(w)) digits += w;
    else if (w in TENS) {
      const next = tok[j + 1];
      if (next && next in UNITS && UNITS[next]! > 0) (digits += String(TENS[w]! + UNITS[next]!)), j++;
      else digits += String(TENS[w]!);
    } else if (w in TEENS) digits += String(TEENS[w]!);
    else if (w in UNITS && w !== "oh") digits += String(UNITS[w]!);
    else break;
    j++;
  }
  return digits ? { digits, end: j } : null;
}

const AIRLINE_WORDS: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [prefix, tel] of Object.entries(TELEPHONY)) {
    const w = tel.toLowerCase().split(" ")[0]!;
    m.set(w, [...(m.get(w) ?? []), prefix]);
  }
  return m;
})();

/** One-digit edit (substitute, insert or delete). */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) return [...a].filter((c, i) => c !== b[i]).length === 1;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

const airlineParts = (cs: string) => /^([A-Z]{3})(\d{1,4})[A-Z]{0,2}$/.exec(cs);

/**
 * Match a transmission to one of `candidates` (ICAO callsigns on radar around that time).
 * `position`: "start" for controller transmissions (callsign first), "end" for pilot readbacks (callsign last),
 * "any" to try both. Returns null when nothing matches or the match is ambiguous.
 */
export function matchCallsign(text: string, candidates: string[], position: "start" | "end" | "any" = "any"): CallsignMatch | null {
  const tok = tokens(text);
  const cands = [...new Set(candidates.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const unique = (xs: string[], method: MatchMethod): CallsignMatch | null => (xs.length === 1 ? { callsign: xs[0]!, method } : null);

  // 1) Airline word followed by a flight number.
  for (let i = 0; i < tok.length; i++) {
    const prefixes = AIRLINE_WORDS.get(tok[i]!);
    if (!prefixes) continue;
    const num = readNumber(tok, i + 1);
    if (!num || num.digits.length < 2) continue;
    const exact = cands.filter((c) => prefixes.some((p) => c === `${p}${num.digits}` || c.startsWith(`${p}${num.digits}`) && /^[A-Z]{0,2}$/.test(c.slice(p.length + num.digits.length))));
    if (exact.length) return unique(exact, "airline");
    if (num.digits.length < 3) continue; // "United two eight left" is a runway, not flight 28
    const near = cands.filter((c) => {
      const m = airlineParts(c);
      return !!m && prefixes.includes(m[1]!) && oneEdit(m[2]!, num.digits);
    });
    const hit = unique(near, "airline_fuzzy");
    if (hit) return hit;
  }

  // 2) N-number by phonetic suffix ("four kilo bravo", "November three four five alpha bravo").
  for (let i = 0; i < tok.length; i++) {
    let s = "";
    let j = i;
    while (j < tok.length && s.length < 6) {
      const w = tok[j]!;
      if (w === "november" && j === i) (j++), (s += "");
      else if (LETTER[w] && w !== "november") (s += LETTER[w]), j++;
      else if (w in UNITS && w !== "oh") (s += String(UNITS[w])), j++;
      else if (/^\d$/.test(w)) (s += w), j++;
      else break;
    }
    if (s.length >= 3 && /[A-Z]/.test(s)) {
      const hit = unique(cands.filter((c) => /^N\d/.test(c) && c.endsWith(s)), "n_number");
      if (hit) return hit;
    }
  }

  // 3) Abbreviated callsign: a bare flight number at the start (controller) or end (readback), unique on radar.
  //    Not when an airline was spoken right before it: "Southwest six seventy-two" is never DAL672.
  const spokenAirline = (start: number) => start > 0 && AIRLINE_WORDS.has(tok[start - 1]!);
  const tryNumberAt = (start: number): CallsignMatch | null => {
    if (spokenAirline(start)) return null;
    const num = readNumber(tok, start);
    if (!num || num.digits.length < 3 || (num.end < tok.length && !STOP.has(tok[num.end]!) && position === "start")) return null;
    return unique(cands.filter((c) => airlineParts(c)?.[2] === num.digits), "number");
  };
  const lead = tok[0] === "norcal" ? 2 : 0; // "NorCal Approach, ..." check-ins
  if (position !== "end") {
    const hit = tryNumberAt(lead);
    if (hit) return hit;
  }
  if (position !== "start") {
    let k = tok.length;
    while (k > 0 && tok[k - 1] === "heavy") k--;
    for (let start = Math.max(0, k - 6); start < k; start++) {
      const num = readNumber(tok, start);
      if (num && num.end === k && num.digits.length >= 3) {
        if (spokenAirline(start)) break;
        const hit = unique(cands.filter((c) => airlineParts(c)?.[2] === num.digits), "number");
        if (hit) return hit;
        break;
      }
    }
  }
  return null;
}

/**
 * Whether `callsign` fits the airline + flight number spoken in the transmission.
 * null when no airline + number (3+ digits) was spoken, so there is nothing to check against.
 */
export function consistentWithSpoken(text: string, callsign: string): boolean | null {
  const tok = tokens(text);
  const m = airlineParts(callsign.trim().toUpperCase());
  let spoken = false;
  for (let i = 0; i < tok.length; i++) {
    const prefixes = AIRLINE_WORDS.get(tok[i]!);
    if (!prefixes) continue;
    const num = readNumber(tok, i + 1);
    if (!num || num.digits.length < 3) continue;
    spoken = true;
    if (m && prefixes.includes(m[1]!) && (m[2] === num.digits || oneEdit(m[2]!, num.digits))) return true;
    // A real airline name with a different carrier on radar (KLM heard as "Delta"): accept an exact flight number.
    if (m && m[2] === num.digits) return true;
  }
  return spoken ? false : null;
}
