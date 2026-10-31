import { describe, expect, test } from "bun:test";
import {
  ATC_KEYTERMS,
  buildKeyterms,
  clampTtsText,
  estimateKeytermTokens,
  listenUrl,
  MAX_KEYTERM_TOKENS,
  MAX_KEYTERMS,
  speak,
  transcribe,
  voiceConfigured,
  voiceModel,
} from "./voice.ts";

const airport = { lat: 37.6188, lon: -122.375 }; // KSFO

// Distances from KSFO: near ~1 NM, mid ~10 NM, far ~25 NM.
const traffic = [
  { hex: "a00001", callsign: "SWA2140", lat: 37.95, lon: -122.375, status: "none" }, // ~20 NM
  { hex: "a00002", callsign: "UAL123", lat: 37.63, lon: -122.375, status: "none" }, // ~0.7 NM
  { hex: "a00003", callsign: "DAL456", lat: 37.78, lon: -122.375, status: "none" }, // ~10 NM
  { hex: "a00004", callsign: "JBU811", lat: 38.0, lon: -122.375, status: "pending" }, // active clearance, far
  { hex: "a00005", callsign: "UAL9", lat: 37.7, lon: -122.375, status: "none" }, // second United (designator dedupe)
  { hex: "a00006", callsign: "N345AB", lat: 37.9, lon: -122.375, status: "none" },
  { hex: "a00007", callsign: "", lat: 37.62, lon: -122.375, status: "none" }, // no callsign: skipped
];

describe("buildKeyterms", () => {
  test("ATC phrases first, then designators, then callsigns by priority", () => {
    const k = buildKeyterms({ traffic, airport, selectedHex: "a00003" });
    expect(k.slice(0, ATC_KEYTERMS.length)).toEqual(ATC_KEYTERMS);
    const rest = k.slice(ATC_KEYTERMS.length);
    // Designators follow callsign priority: selected DAL, then active JBU, then UAL (nearest), SWA. Deduped.
    expect(rest.slice(0, 4)).toEqual(["Delta", "JetBlue", "United", "Southwest"]);
    const cs = rest.slice(4);
    expect(cs[0]).toBe("Delta four fifty-six"); // selected
    expect(cs[1]).toBe("JetBlue eight eleven"); // active clearance
    expect(cs.slice(2)).toEqual([
      "United one twenty-three", // ~0.7 NM
      "United nine", // ~5 NM
      "November three four five alpha bravo", // ~17 NM
      "Southwest twenty-one forty", // ~20 NM
    ]);
  });

  test("no selection: active clearances first; selected hex is case-insensitive", () => {
    const k = buildKeyterms({ traffic, airport });
    expect(k[ATC_KEYTERMS.length + 4]).toBe("JetBlue eight eleven");
    const k2 = buildKeyterms({ traffic, airport, selectedHex: "A00001" });
    expect(k2[ATC_KEYTERMS.length + 4]).toBe("Southwest twenty-one forty");
  });

  test("dedupes case-insensitively and works without an airport", () => {
    const dup = [
      { hex: "b1", callsign: "UAL123", lat: 0, lon: 0, status: "none" },
      { hex: "b2", callsign: "ual123 ", lat: 0, lon: 0, status: "none" },
    ];
    const k = buildKeyterms({ traffic: dup, airport: null });
    expect(k.filter((t) => t === "United one twenty-three").length).toBe(1);
    expect(k.filter((t) => t === "United").length).toBe(1);
    expect(new Set(k.map((t) => t.toLowerCase())).size).toBe(k.length);
  });

  test("caps at 100 terms and under the token budget", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      hex: `c${i}`,
      callsign: `UAL${i + 1}`,
      lat: airport.lat + i * 0.001,
      lon: airport.lon,
      status: "none",
    }));
    const k = buildKeyterms({ traffic: many, airport });
    expect(k.length).toBeLessThanOrEqual(MAX_KEYTERMS);
    expect(k.reduce((n, t) => n + estimateKeytermTokens(t), 0)).toBeLessThanOrEqual(MAX_KEYTERM_TOKENS);
    expect(k.slice(0, ATC_KEYTERMS.length)).toEqual(ATC_KEYTERMS);
    expect(k[ATC_KEYTERMS.length + 1]).toBe("United one"); // nearest first

    // Short terms only: the 100-term cap binds before the token budget.
    const short = Array.from({ length: 300 }, (_, i) => ({ hex: `d${i}`, callsign: `N${i + 1}`, lat: 0, lon: 0, status: "none" }));
    expect(buildKeyterms({ traffic: short, airport: null }).length).toBeLessThanOrEqual(MAX_KEYTERMS);
  });
});

describe("listen URL", () => {
  test("nova-3 with punctuation, no smart_format, one keyterm param per term", () => {
    const u = new URL(listenUrl(["climb and maintain", "United one twenty-three"]));
    expect(u.pathname).toBe("/v1/listen");
    expect(u.searchParams.get("model")).toBe("nova-3");
    expect(u.searchParams.get("punctuate")).toBe("true");
    expect(u.searchParams.has("smart_format")).toBe(false); // it turns "November three four five" into a date
    expect(u.searchParams.getAll("keyterm")).toEqual(["climb and maintain", "United one twenty-three"]);
  });
});

describe("TTS helpers", () => {
  test("voice mapping", () => {
    expect(voiceModel("aura-2-zeus-en")).toBe("aura-2-zeus-en");
    expect(voiceModel("SOUTH")).toMatch(/^aura-2-.+-en$/);
    expect(voiceModel("NORTH")).toMatch(/^aura-2-.+-en$/);
    expect(voiceModel("MONITOR")).toMatch(/^aura-2-.+-en$/);
    expect(voiceModel("SOUTH")).not.toBe(voiceModel("NORTH"));
    expect(voiceModel(undefined)).toBe(voiceModel("NORTH"));
  });

  test("clamps text to 2000 characters at a word boundary", () => {
    const long = "radar contact ".repeat(300);
    const c = clampTtsText(long);
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c.endsWith("radar") || c.endsWith("contact")).toBe(true);
    expect(clampTtsText("  United   one twenty-three  ")).toBe("United one twenty-three");
  });
});

const live = voiceConfigured();
if (!live) console.log("[voice.test] DEEPGRAM_API_KEY is empty: skipping live Deepgram round trip.");

describe("live Deepgram round trip", () => {
  test.skipIf(!live)(
    "speak -> transcribe with keyterms",
    async () => {
      const text = "United one twenty-three, climb and maintain one zero thousand.";
      const s1 = await speak(text, "NORTH");
      expect(s1.audio.byteLength).toBeGreaterThan(1000);
      expect(s1.cached).toBe(false);
      const s2 = await speak(text, "NORTH");
      expect(s2.cached).toBe(true);

      const keyterms = buildKeyterms({ traffic, airport, selectedHex: "a00002" });
      const r = await transcribe(s1.audio, s1.contentType, keyterms);
      console.log(`[voice.test] contentType=${s1.contentType} bytes=${s1.audio.byteLength}`);
      console.log(`[voice.test] transcript="${r.transcript}" confidence=${r.confidence} ms=${r.ms}`);
      expect(r.transcript.toLowerCase()).toContain("united");
      expect(r.transcript.toLowerCase()).toMatch(/climb/);

      // N-number + "six thousand five hundred": stays in spoken words (smart_format made it "11/03/1945 AB ... 6,500").
      const n = await speak("November three four five alpha bravo, maintain six thousand five hundred.", "SOUTH");
      expect(voiceModel("SOUTH")).not.toBe(voiceModel("NORTH"));
      const rn = await transcribe(n.audio, n.contentType, keyterms);
      console.log(`[voice.test] transcript="${rn.transcript}" ms=${rn.ms}`);
      expect(rn.transcript.toLowerCase()).toContain("november three four five alpha bravo");
      expect(rn.transcript).not.toMatch(/\d/);
    },
    30_000,
  );
});
