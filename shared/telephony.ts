// Callsigns and telephony designators (CLAUDE.md section 9).

/** ICAO airline prefix -> spoken telephony designator. */
export const TELEPHONY: Record<string, string> = {
  // From CLAUDE.md
  UAL: "United",
  DAL: "Delta",
  AAL: "American",
  SWA: "Southwest",
  ASA: "Alaska",
  JBU: "JetBlue",
  SKW: "SkyWest",
  FFT: "Frontier Flight",
  NKS: "Spirit Wings",
  HAL: "Hawaiian",
  FDX: "FedEx",
  UPS: "UPS",
  RPA: "Brickyard",
  ENY: "Envoy",
  EDV: "Endeavor",
  AAY: "Allegiant",
  QXE: "Horizon",
  // US regionals, cargo, charter
  JIA: "Bluestreak",
  PDT: "Piedmont",
  CPZ: "Compass",
  GJS: "Lindbergh",
  MXY: "Moxy",
  VXP: "Avelo",
  SCX: "Sun Country",
  GTI: "Giant",
  ABX: "Abex",
  ATN: "Air Transport",
  LXJ: "Flexjet",
  EJA: "Execjet",
  // International
  BAW: "Speedbird",
  DLH: "Lufthansa",
  AFR: "Airfrance",
  ACA: "Air Canada",
  WJA: "Westjet",
  KLM: "KLM",
  UAE: "Emirates",
  QFA: "Qantas",
  ANA: "All Nippon",
  JAL: "Japan Air",
  SIA: "Singapore",
  CPA: "Cathay",
  KAL: "Korean Air",
  EVA: "Eva",
  CAL: "Dynasty",
  AAR: "Asiana",
  VIR: "Virgin",
  AMX: "Aeromexico",
  VOI: "Volaris",
  TAI: "Taca",
  QTR: "Qatari",
  THY: "Turkish",
  ETD: "Etihad",
  CCA: "Air China",
  CES: "China Eastern",
  CSN: "China Southern",
  FIN: "Finnair",
  IBE: "Iberia",
  SWR: "Swiss",
  AUA: "Austrian",
  EIN: "Shamrock",
  ICE: "Iceair",
  ANZ: "New Zealand",
  NZM: "New Zealand",
  PAL: "Philippine",
};

export const PHONETIC: Record<string, string> = {
  A: "alpha", B: "bravo", C: "charlie", D: "delta", E: "echo", F: "foxtrot", G: "golf",
  H: "hotel", I: "india", J: "juliet", K: "kilo", L: "lima", M: "mike", N: "november",
  O: "oscar", P: "papa", Q: "quebec", R: "romeo", S: "sierra", T: "tango", U: "uniform",
  V: "victor", W: "whiskey", X: "x-ray", Y: "yankee", Z: "zulu",
};

/** Plain digit words ("nine", not "niner": better for text-to-speech and speech-to-text). */
export const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0..99 in words: 5 -> "five", 12 -> "twelve", 23 -> "twenty-three". */
export function numberWords(n: number): string {
  if (n < 10) return DIGIT_WORDS[n]!;
  if (n < 20) return TEENS[n - 10]!;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t]! : `${TENS[t]}-${DIGIT_WORDS[o]}`;
}

/** Each digit spoken separately: "270" -> "two seven zero". */
export function digitsIndividually(num: string): string {
  return num
    .split("")
    .map((ch) => DIGIT_WORDS[Number(ch)] ?? ch)
    .join(" ");
}

/** Pair of digits in group form; a leading zero is spoken: "05" -> "zero five". */
function pairWords(pair: string): string {
  if (pair[0] === "0") return `zero ${DIGIT_WORDS[Number(pair[1])]}`;
  return numberWords(Number(pair));
}

/**
 * Air carrier flight number in group form:
 * "123" -> "one twenty-three", "2140" -> "twenty-one forty", "105" -> "one zero five",
 * "100" -> "one hundred", "2100" -> "twenty-one hundred", "1000" -> "one thousand".
 */
export function digitsGroupWords(num: string): string {
  if (!/^\d+$/.test(num)) return num;
  if (num.length > 1 && num[0] === "0") return digitsIndividually(num);
  switch (num.length) {
    case 1:
      return DIGIT_WORDS[Number(num)]!;
    case 2:
      return numberWords(Number(num));
    case 3: {
      const first = DIGIT_WORDS[Number(num[0])]!;
      const rest = num.slice(1);
      if (rest === "00") return `${first} hundred`;
      return `${first} ${pairWords(rest)}`;
    }
    case 4: {
      if (num.slice(1) === "000") return `${DIGIT_WORDS[Number(num[0])]} thousand`;
      const head = numberWords(Number(num.slice(0, 2)));
      const rest = num.slice(2);
      if (rest === "00") return `${head} hundred`;
      return `${head} ${pairWords(rest)}`;
    }
    default:
      return digitsIndividually(num);
  }
}

/** Letters phonetically, digits individually. */
function spellOut(s: string): string {
  return s
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .split("")
    .map((ch) => PHONETIC[ch] ?? DIGIT_WORDS[Number(ch)] ?? ch)
    .join(" ");
}

const AIRLINE_RE = /^([A-Z]{3})(\d{1,4})([A-Z]{0,2})$/;
const N_NUMBER_RE = /^N[0-9][0-9A-Z]{0,4}$/;

export function airlinePrefix(callsign: string): string | null {
  const m = callsign.trim().toUpperCase().match(/^([A-Z]{3})\d/);
  return m ? m[1]! : null;
}

export function telephonyOf(callsign: string): string | null {
  const p = airlinePrefix(callsign);
  return p ? (TELEPHONY[p] ?? null) : null;
}

/**
 * Spoken callsign: "UAL123" -> "United one twenty-three", "N335RV" -> "November three three five romeo victor",
 * unknown prefix -> letters phonetically and digits individually.
 */
export function spokenCallsign(callsign: string): string {
  const cs = callsign.trim().toUpperCase();
  if (N_NUMBER_RE.test(cs)) return `November ${spellOut(cs.slice(1))}`;
  const m = cs.match(AIRLINE_RE);
  if (m) {
    const [, prefix, num, suffix] = m;
    const tel = TELEPHONY[prefix!];
    if (tel) return [tel, digitsGroupWords(num!), suffix ? spellOut(suffix) : ""].filter(Boolean).join(" ");
  }
  return spellOut(cs);
}

/** Spoken forms useful for matching transcripts (group form and individual-digit form). */
export function callsignVariants(callsign: string): string[] {
  const cs = callsign.trim().toUpperCase();
  const out = new Set<string>([spokenCallsign(cs)]);
  const m = cs.match(AIRLINE_RE);
  if (m) {
    const [, prefix, num, suffix] = m;
    const tel = TELEPHONY[prefix!];
    const suf = suffix ? " " + spellOut(suffix) : "";
    if (tel) {
      out.add(`${tel} ${digitsIndividually(num!)}${suf}`);
      out.add(`${tel} ${num}${suffix ?? ""}`);
    }
    out.add(`${spellOut(prefix!)} ${digitsIndividually(num!)}${suf}`);
  }
  if (N_NUMBER_RE.test(cs)) out.add(spellOut(cs.slice(1)));
  return [...out];
}
