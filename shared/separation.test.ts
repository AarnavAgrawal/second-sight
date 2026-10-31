import { describe, expect, test } from "bun:test";
import { conflictAlert, firstLoss, lossOfSeparation, projectStraight, straightPath } from "./separation.ts";
import { haversineNm } from "./geo.ts";
import { SFO, offset, pos } from "./test-utils.ts";

describe("lossOfSeparation", () => {
  test("needs both lateral < 3 NM and vertical < 1,000 ft", () => {
    expect(lossOfSeparation(2.9, 900)).toBe(true);
    expect(lossOfSeparation(3, 0)).toBe(false);
    expect(lossOfSeparation(0, 1000)).toBe(false);
    expect(lossOfSeparation(5, 0)).toBe(false);
  });
});

describe("projectStraight", () => {
  test("moves gs * t along the track and applies vertical rate", () => {
    const p = pos({ gsKt: 360, trackTrueDeg: 0, vertRateFpm: 1200, altFt: 5000 });
    const q = projectStraight(p, 60);
    expect(haversineNm(p.lat, p.lon, q.lat, q.lon)).toBeCloseTo(6, 2);
    expect(q.lat).toBeGreaterThan(p.lat);
    expect(q.altFt).toBe(6200);
  });
  test("null altitude stays null", () => {
    expect(projectStraight(pos({ altFt: null }), 30).altFt).toBeNull();
  });
});

describe("conflictAlert", () => {
  const a = pos({ hex: "aaa", callsign: "UAL123", trackTrueDeg: 90, gsKt: 250, altFt: 8000 });
  const headOn = (altFt: number) =>
    offset(a, 90, 10, { hex: "bbb", callsign: "DAL456", trackTrueDeg: 270, gsKt: 250, altFt });

  test("head-on at the same altitude produces a CA", () => {
    const cas = conflictAlert([a, headOn(8000)], SFO);
    expect(cas).toHaveLength(1);
    const ca = cas[0]!;
    // 10 NM apart, 500 kt closure: inside 3 NM after ~50 s -> first 10 s sample is 60 s.
    expect(ca.inSec).toBe(60);
    expect(ca.minLatNm).toBeLessThan(0.5);
    expect(ca.minVertFt).toBe(0);
    // a < b by callsign
    expect(ca.a).toBe("DAL456");
    expect(ca.b).toBe("UAL123");
    expect(ca.hexA).toBe("bbb");
  });

  test("same pair 2,000 ft apart: no CA", () => {
    expect(conflictAlert([a, headOn(10000)], SFO)).toHaveLength(0);
  });

  test("pairs both below field elevation + 1,000 ft are ignored", () => {
    const lowA = { ...a, altFt: 800 };
    const lowB = { ...headOn(800) };
    expect(conflictAlert([lowA, lowB], SFO)).toHaveLength(0);
  });

  test("aircraft with unknown altitude are skipped", () => {
    expect(conflictAlert([a, { ...headOn(8000), altFt: null }], SFO)).toHaveLength(0);
  });

  test("diverging aircraft far apart: no CA", () => {
    const b = offset(a, 90, 10, { hex: "bbb", callsign: "DAL456", trackTrueDeg: 90, gsKt: 250 });
    expect(conflictAlert([a, b], SFO)).toHaveLength(0);
  });
});

describe("firstLoss", () => {
  test("returns null when separation holds", () => {
    const a = pos();
    const b = offset(a, 0, 5, { hex: "b" });
    expect(firstLoss(straightPath(a), straightPath(b))).toBeNull();
  });
  test("reports t=0 when already inside both minimums", () => {
    const a = pos();
    const b = offset(a, 0, 1, { hex: "b", altFt: 8500 });
    const r = firstLoss(straightPath(a), straightPath(b))!;
    expect(r.inSec).toBe(0);
    expect(r.minVertFt).toBe(500);
  });
});
