import { describe, expect, test } from "bun:test";
import { CANDIDATE_TAGS, candidateScore, generateCandidates } from "./candidates.ts";
import { probeClearance, simplifiedFloorFt } from "./probe.ts";
import { conflictAlert } from "./separation.ts";
import { clearancePhrase } from "./phraseology.ts";
import type { Agreement, Candidate, Position } from "./types.ts";
import { SFO, T0, offset, pos } from "./test-utils.ts";

const north = (nm: number, over: Partial<Position> = {}) => pos({ lat: SFO.lat + nm / 60, lon: SFO.lon, ...over });

/**
 * Climbing departure 6 NM north, northbound, 6,000 climbing 2,000 fpm. Crossing traffic level at 9,000,
 * eastbound, crosses the departure's path about 80 s ahead.
 */
function departureScene() {
  const dep = north(6, { hex: "a00001", callsign: "UAL123", altFt: 6000, vertRateFpm: 2000, gsKt: 250, trackTrueDeg: 0 });
  const crossing = offset(dep, 0, 5.56);
  const traffic = offset(crossing, 270, 5.56, {
    hex: "b00002",
    callsign: "DAL456",
    altFt: 9000,
    vertRateFpm: 0,
    gsKt: 250,
    trackTrueDeg: 90,
  });
  return { dep, traffic: [dep, traffic] };
}

function expectWellFormed(cands: Candidate[], ac: Position, traffic: Position[]) {
  cands.forEach((c, i) => {
    expect(c.id).toBe(`c${i + 1}`);
    expect(probeClearance(ac, c, traffic, SFO).ok).toBe(true);
    expect(c.phraseology).toBe(clearancePhrase(ac.callsign, c, ac.altFt));
    for (const t of c.tags) {
      expect(CANDIDATE_TAGS.includes(t) || t.startsWith("breaks_agreement:")).toBe(true);
    }
  });
  for (let i = 1; i < cands.length; i++) {
    expect(candidateScore(cands[i]!)).toBeGreaterThanOrEqual(candidateScore(cands[i - 1]!));
  }
  expect(cands.length).toBeLessThanOrEqual(6);
}

describe("generateCandidates: CIC request", () => {
  test("departure climbing into traffic: requested climb fails, candidates all pass", () => {
    const { dep, traffic } = departureScene();
    const req = { kind: "altitude" as const, value: 10000 };
    expect(probeClearance(dep, req, traffic, SFO).ok).toBe(false);
    const cands = generateCandidates(dep, req, traffic, SFO, { now: T0 });
    expect(cands.length).toBeGreaterThanOrEqual(3);
    expectWellFormed(cands, dep, traffic);
    expect(cands.some((c) => c.kind === "altitude" && c.value === 10000)).toBe(false);
  });

  test("tags: stopping the climb vs keeping it (heading keeps the climb)", () => {
    const { dep, traffic } = departureScene();
    const cands = generateCandidates(dep, { kind: "altitude", value: 10000 }, traffic, SFO, { now: T0 });
    const stop = cands.find((c) => c.kind === "altitude" && c.value === 6000);
    expect(stop).toBeDefined();
    expect(stop!.tags).toContain("stops_climb");
    expect(stop!.tags).not.toContain("keeps_climb");
    const heading = cands.find((c) => c.kind === "heading");
    expect(heading).toBeDefined();
    expect(heading!.tags).toContain("keeps_climb");
    expect(heading!.turn === "left" || heading!.turn === "right").toBe(true);
    // Stops short of the crossing traffic's 9,000; 9,000 and above conflict.
    expect(cands.filter((c) => c.kind === "altitude").every((c) => c.value <= 8000)).toBe(true);
    expect(cands[0]).toMatchObject({ id: "c1", kind: "altitude", value: 8000, deviation: 2000 });
  });

  test("tags: away_from_airport for a northbound departure, toward for a southbound arrival", () => {
    const { dep, traffic } = departureScene();
    const cands = generateCandidates(dep, { kind: "altitude", value: 10000 }, traffic, SFO, { now: T0 });
    const altCand = cands.find((c) => c.kind === "altitude")!;
    expect(altCand.tags).toContain("away_from_airport");
    const arr = north(20, { altFt: 8000, vertRateFpm: -1000, trackTrueDeg: 180 });
    const arrCands = generateCandidates(arr, { kind: "altitude", value: 6000 }, [arr], SFO, { now: T0 });
    for (const c of arrCands.filter((c) => c.kind === "altitude")) expect(c.tags).toContain("toward_airport");
    for (const c of arrCands.filter((c) => c.kind === "altitude" && c.value < 8000)) expect(c.tags).toContain("keeps_descent");
    for (const c of arrCands.filter((c) => c.kind === "altitude" && c.value >= 8000)) expect(c.tags).toContain("stops_descent");
  });

  test("tags: large_deviation beyond 2,000 ft or 40 degrees", () => {
    const ac = north(10, { altFt: 8000, vertRateFpm: 0, trackTrueDeg: 90 });
    const cands = generateCandidates(ac, { kind: "altitude", value: 10000 }, [ac], SFO, { now: T0, max: 50 });
    for (const c of cands) {
      const large = c.kind === "altitude" ? c.deviation > 2000 : c.deviation > 40;
      expect(c.tags.includes("large_deviation")).toBe(large);
    }
    expect(cands.some((c) => c.tags.includes("large_deviation"))).toBe(true);
  });

  test("tags: enters_other_sector_120s near the boundary", () => {
    const ac = pos({ lat: SFO.lat - 2 / 60, lon: SFO.lon, altFt: 8000, trackTrueDeg: 0, gsKt: 240 });
    const cands = generateCandidates(ac, { kind: "altitude", value: 9000 }, [ac], SFO, { now: T0, owner: "SOUTH" });
    const altCands = cands.filter((c) => c.kind === "altitude");
    expect(altCands.length).toBeGreaterThan(0);
    for (const c of altCands) expect(c.tags).toContain("enters_other_sector_120s");
    // Default owner is the sector by current latitude (SOUTH here).
    const dflt = generateCandidates(ac, { kind: "altitude", value: 9000 }, [ac], SFO, { now: T0 });
    expect(dflt.find((c) => c.kind === "altitude")!.tags).toContain("enters_other_sector_120s");
    // Far from the line: no tag.
    const far = north(20, { altFt: 8000, trackTrueDeg: 90 });
    for (const c of generateCandidates(far, { kind: "altitude", value: 9000 }, [far], SFO, { now: T0 })) {
      expect(c.tags).not.toContain("enters_other_sector_120s");
    }
  });

  test("tags: breaks_agreement:<id> from an active agreement", () => {
    const { dep, traffic } = departureScene();
    const ag: Agreement = {
      id: "ag7",
      hex: dep.hex,
      callsign: dep.callsign,
      constraint: { kind: "altitude", op: "at_or_below", value: 6000 },
      between: ["NORTH", "SOUTH"],
      source: "APREQ",
      text: "UAL123 maintain 6,000 (APREQ)",
      createdAt: T0,
      expiresAt: T0 + 300_000,
      state: "active",
    };
    const cands = generateCandidates(dep, { kind: "altitude", value: 10000 }, traffic, SFO, {
      now: T0,
      agreements: [ag],
      max: 50,
    });
    for (const c of cands) {
      const breaks = c.kind === "altitude" && c.value > 6000;
      expect(c.tags.includes("breaks_agreement:ag7")).toBe(breaks);
    }
    expect(cands.some((c) => c.tags.includes("breaks_agreement:ag7"))).toBe(true);
    // Expired agreements are ignored.
    const later = generateCandidates(dep, { kind: "altitude", value: 10000 }, traffic, SFO, {
      now: T0 + 300_000,
      agreements: [ag],
    });
    for (const c of later) expect(c.tags.some((t) => t.startsWith("breaks_agreement:"))).toBe(false);
  });

  test("respects the simplified floor and returns at most max", () => {
    const ac = north(10, { altFt: 3000, vertRateFpm: -1000, trackTrueDeg: 180 });
    const cands = generateCandidates(ac, { kind: "altitude", value: 2000 }, [ac], SFO, { now: T0, max: 50 });
    const floor = simplifiedFloorFt(SFO);
    for (const c of cands.filter((c) => c.kind === "altitude")) expect(c.value).toBeGreaterThanOrEqual(floor);
    expect(generateCandidates(ac, { kind: "altitude", value: 2000 }, [ac], SFO, { now: T0, max: 2 })).toHaveLength(2);
    expect(generateCandidates(ac, { kind: "altitude", value: 2000 }, [ac], SFO, { now: T0 }).length).toBeLessThanOrEqual(6);
  });

  test("flight levels: never above FL450, phraseology uses flight level", () => {
    const ac = north(15, { altFt: 35000, vertRateFpm: 0, trackTrueDeg: 90, gsKt: 450 });
    const cands = generateCandidates(ac, { kind: "altitude", value: 44000 }, [ac], SFO, { now: T0, max: 50 });
    const alts = cands.filter((c) => c.kind === "altitude");
    expect(alts.length).toBeGreaterThan(0);
    for (const c of alts) {
      expect(c.value).toBeLessThanOrEqual(45000);
      expect(c.phraseology).toContain("flight level");
    }
    expect(alts.some((c) => c.value === 45000)).toBe(true);
  });

  test("heading request: headings around the requested heading, turn = shortest from current magnetic track", () => {
    const ac = north(10, { altFt: 8000, vertRateFpm: 0, trackTrueDeg: 103 }); // magnetic 090 with 13 deg east
    const cands = generateCandidates(ac, { kind: "heading", value: 180, turn: "right" }, [ac], SFO, { now: T0, max: 50 });
    const hdgs = cands.filter((c) => c.kind === "heading");
    expect(hdgs.map((c) => c.value).sort((a, b) => a - b)).toEqual([120, 140, 160, 200, 220, 240]);
    for (const c of hdgs) {
      expect(c.turn).toBe("right");
      expect(c.deviation).toBe(Math.abs(c.value - 180));
    }
    // Altitude options are around the current altitude and include "maintain" the current altitude.
    const alts = cands.filter((c) => c.kind === "altitude");
    expect(alts.some((c) => c.value === 8000)).toBe(true);
    for (const c of alts) expect(c.deviation).toBe(Math.abs(c.value - 8000));
  });

  test("empty when the aircraft altitude is unknown and only altitude options are requested", () => {
    const ac = north(10, { altFt: null });
    expect(generateCandidates(ac, null, [ac], SFO, { goal: "handoff_condition", now: T0 })).toEqual([]);
  });
});

describe("generateCandidates: resolve_conflict", () => {
  test("two converging aircraft at the same altitude: every candidate removes the conflict", () => {
    const a = north(10, { hex: "a00001", callsign: "UAL123", altFt: 8000, trackTrueDeg: 90, gsKt: 250 });
    const b = offset(a, 90, 10, { hex: "b00002", callsign: "DAL456", altFt: 8000, trackTrueDeg: 270, gsKt: 250 });
    const traffic = [a, b];
    expect(conflictAlert(traffic, SFO)).toHaveLength(1);
    const cands = generateCandidates(a, null, traffic, SFO, { goal: "resolve_conflict", now: T0 });
    expect(cands.length).toBeGreaterThanOrEqual(3);
    expectWellFormed(cands, a, traffic);
    // Maintaining the current altitude does not resolve a head-on conflict at the same altitude.
    expect(cands.some((c) => c.kind === "altitude" && c.value === 8000)).toBe(false);
    for (const c of cands) {
      if (c.kind === "altitude") expect(c.deviation).toBe(Math.abs(c.value - 8000));
    }
  });
});

describe("generateCandidates: handoff_condition", () => {
  test("altitude-only options around the current altitude", () => {
    const ac = north(3, { altFt: 7800, vertRateFpm: 0, trackTrueDeg: 180 });
    const cands = generateCandidates(ac, null, [ac], SFO, { goal: "handoff_condition", owner: "NORTH", now: T0 });
    expect(cands.every((c) => c.kind === "altitude")).toBe(true);
    expect(cands.map((c) => c.value)).toEqual([7800, 6800, 8800, 5800, 9800]);
    expect(cands[0]!.phraseology).toContain("maintain seven thousand eight hundred");
  });
});
