// Tests for the shared separation rules (separation.ts pairRule): one rule set for both the conflict alert and the probe.
import { describe, expect, test } from "bun:test";
import { destination } from "./geo.ts";
import { probeClearance } from "./probe.ts";
import { SEPARATION, conflictAlert, conflictAndTrafficAlerts, firstLoss, onFinalApproach, pairRule, straightPath } from "./separation.ts";
import { SFO, offset, pos } from "./test-utils.ts";
import type { Position } from "./types.ts";

/** Position `distNm` from SFO along true `bearing`. */
const fromSfo = (bearing: number, distNm: number, over: Partial<Position> = {}) => {
  const d = destination(SFO.lat, SFO.lon, bearing, distNm);
  return pos({ ...over, lat: d.lat, lon: d.lon });
};

// SFO 28L/28R: final approach course ~284 magnetic = ~297 true; arrivals come in from the southeast.
const FINAL_TRUE = 297;
const onFinal = (over: Partial<Position> = {}) =>
  fromSfo(FINAL_TRUE - 180, 8, { hex: "aaa001", callsign: "UAL1", altFt: 3000, vertRateFpm: -700, gsKt: 150, trackTrueDeg: FINAL_TRUE, ...over });
/** Side by side on the adjacent runway's final: 750 ft (0.12 NM) to the right of `a`. */
const alongside = (a: Position, over: Partial<Position> = {}) =>
  offset(a, FINAL_TRUE + 90, 0.12, { hex: "bbb002", callsign: "SKW2", altFt: 3000, vertRateFpm: -700, gsKt: 150, trackTrueDeg: FINAL_TRUE, ...over });

describe("SEPARATION config", () => {
  test("all thresholds in one object", () => {
    expect(SEPARATION.standardLatNm).toBe(3);
    expect(SEPARATION.standardVertFt).toBe(1000);
    expect(SEPARATION.highAltitudeLatNm).toBe(5);
    expect(SEPARATION.vfrSquawk).toBe("1200");
    expect(SEPARATION.finalRadiusNm).toBe(12);
  });
});

describe("final approach suppression", () => {
  const a = onFinal();
  const b = alongside(a);
  test("SFO 28L/28R side-by-side pair (0.12 NM apart, 3,000 ft, descending 700 fpm) does not alert", () => {
    expect(onFinalApproach(a, SFO)).toBe(true);
    expect(onFinalApproach(b, SFO)).toBe(true);
    expect(pairRule(a, b, SFO).basis).toBe("final_suppressed");
    expect(conflictAlert([a, b], SFO)).toEqual([]);
    // Without the rule this would be an immediate loss of standard separation.
    expect(firstLoss(straightPath(a), straightPath(b))?.inSec).toBe(0);
  });
  test("the same pair never fails the probe", () => {
    expect(probeClearance(a, { kind: "altitude", value: 2500 }, [a, b], SFO).ok).toBe(true);
    expect(probeClearance(b, { kind: "heading", value: 284 }, [a, b], SFO).ok).toBe(true);
  });
  test("not applied when one aircraft is climbing", () => {
    expect(pairRule(a, alongside(a, { vertRateFpm: 700 }), SFO).basis).toBe("standard");
    expect(conflictAlert([a, alongside(a, { vertRateFpm: 700 })], SFO)).toHaveLength(1);
  });
  test("not applied when one aircraft is descending slower than 300 fpm", () => {
    expect(pairRule(a, alongside(a, { vertRateFpm: -200 }), SFO).basis).toBe("standard");
  });
  test("not applied when one aircraft is receding from the airport", () => {
    const out = alongside(a, { trackTrueDeg: FINAL_TRUE - 180 });
    expect(onFinalApproach(out, SFO)).toBe(false);
    expect(conflictAlert([a, out], SFO)).toHaveLength(1);
  });
  test("not applied when one aircraft is above field elevation + 4,000 ft", () => {
    const hi = onFinal({ altFt: 4200 });
    const lo = alongside(hi, { altFt: 3900 });
    expect(onFinalApproach(hi, SFO)).toBe(false);
    expect(onFinalApproach(lo, SFO)).toBe(true);
    expect(conflictAlert([hi, lo], SFO)).toHaveLength(1);
  });
  test("not applied when one aircraft is beyond 12 NM", () => {
    const far = fromSfo(FINAL_TRUE - 180, 12.3, { hex: "aaa001", callsign: "UAL1", altFt: 3000, vertRateFpm: -700, gsKt: 150, trackTrueDeg: FINAL_TRUE });
    const near = offset(fromSfo(FINAL_TRUE - 180, 11.8), FINAL_TRUE + 90, 0.12, { hex: "bbb002", callsign: "SKW2", altFt: 3000, vertRateFpm: -700, gsKt: 150, trackTrueDeg: FINAL_TRUE });
    expect(onFinalApproach(far, SFO)).toBe(false);
    expect(onFinalApproach(near, SFO)).toBe(true);
    expect(conflictAlert([far, near], SFO)).toHaveLength(1);
  });
});

describe("high-altitude minimum (both at or above 18,000 ft: 5 NM)", () => {
  const pair = (altFt: number) => {
    const a = pos({ hex: "aaa001", callsign: "UAL1", altFt, trackTrueDeg: 90, gsKt: 450 });
    const b = offset(a, 0, 4, { hex: "bbb002", callsign: "DAL2", altFt, trackTrueDeg: 90, gsKt: 450 });
    return [a, b];
  };
  test("FL350, 4 NM apart, same level: alerts", () => {
    const ca = conflictAlert(pair(35_000), SFO);
    expect(ca).toHaveLength(1);
    expect(ca[0]!.basis).toBe("high_altitude");
  });
  test("same geometry at 10,000 ft: no alert (3 NM)", () => {
    expect(conflictAlert(pair(10_000), SFO)).toEqual([]);
  });
  test("one below 18,000 ft: standard", () => {
    const [a, b] = pair(18_000);
    expect(pairRule(a!, { ...b!, altFt: 17_500 }, SFO).basis).toBe("standard");
  });
  test("the probe uses the same minimum", () => {
    const [a, b] = pair(35_000);
    const r = probeClearance(a!, { kind: "altitude", value: 35_000 }, [a!, b!], SFO);
    expect(r.ok).toBe(false);
    expect(r.conflicts[0]!.basis).toBe("high_altitude");
    expect(r.reasons[0]).toContain("5 NM above FL180");
  });
});

describe("VFR", () => {
  const ifr = pos({ hex: "aaa001", callsign: "UAL1", altFt: 4500, trackTrueDeg: 90, gsKt: 200, isVfr: false });
  const vfrAt = (distNm: number, vertFt: number, over: Partial<Position> = {}) =>
    offset(ifr, 0, distNm, { hex: "ccc003", callsign: "N123AB", altFt: 4500 + vertFt, trackTrueDeg: 90, gsKt: 200, isVfr: true, ...over });

  test("VFR/IFR at 1.2 NM / 400 ft: conflict (Class B VFR minima 1.5 NM / 500 ft)", () => {
    const ca = conflictAlert([ifr, vfrAt(1.2, 400)], SFO);
    expect(ca).toHaveLength(1);
    expect(ca[0]!.basis).toBe("vfr_mixed");
  });
  test("VFR/IFR at 2 NM: no conflict (two IFR aircraft at 2 NM would be)", () => {
    expect(conflictAlert([ifr, vfrAt(2, 0)], SFO)).toEqual([]);
    expect(conflictAlert([ifr, vfrAt(2, 0, { isVfr: false })], SFO)).toHaveLength(1);
  });
  test("VFR/VFR: traffic advisory, not a conflict alert", () => {
    const a = vfrAt(0, 0, { hex: "ddd004", callsign: "N456CD" });
    const b = vfrAt(1.2, 300);
    const r = conflictAndTrafficAlerts([a, b], SFO);
    expect(r.conflicts).toEqual([]);
    expect(r.traffic).toHaveLength(1);
    expect(r.traffic[0]!.basis).toBe("vfr_pair");
    expect(conflictAlert([a, b], SFO)).toEqual([]);
  });
  test("VFR/VFR never fails the probe", () => {
    const a = vfrAt(0, 0, { hex: "ddd004", callsign: "N456CD" });
    const b = vfrAt(0.5, 0);
    expect(probeClearance(a, { kind: "altitude", value: 4500 }, [a, b], SFO).ok).toBe(true);
  });
  test("falls back to the raw squawk when isVfr is absent", () => {
    const a = vfrAt(1.2, 400, { isVfr: undefined, squawk: "1200" });
    expect(pairRule(ifr, a, SFO).basis).toBe("vfr_mixed");
  });
});

describe("visual separation (eval context)", () => {
  const a = pos({ hex: "aaa001", callsign: "UAL1", altFt: 8000, trackTrueDeg: 90 });
  const b = offset(a, 0, 1, { hex: "bbb002", callsign: "DAL2", altFt: 8000, trackTrueDeg: 90 });
  test("either aircraft visually separated, both below 18,000 ft: no alert", () => {
    expect(pairRule(a, b, SFO, { visualHex: new Set(["bbb002"]) }).basis).toBe("visual");
    expect(conflictAlert([a, b], SFO, { visualHex: new Set(["aaa001"]) })).toEqual([]);
    expect(probeClearance(a, { kind: "altitude", value: 8000 }, [a, b], SFO, { visualHex: new Set(["aaa001"]) }).ok).toBe(true);
  });
  test("not applied at or above 18,000 ft", () => {
    const hi = { ...a, altFt: 20_000 };
    const hi2 = { ...b, altFt: 20_000 };
    expect(pairRule(hi, hi2, SFO, { visualHex: new Set(["aaa001"]) }).basis).toBe("high_altitude");
  });
});

describe("firstLoss with custom minima", () => {
  test("lat < latNm AND vert < vertFt", () => {
    const a = pos({ trackTrueDeg: 90 });
    const b = offset(a, 0, 2, { hex: "bbb002", trackTrueDeg: 90, altFt: 8400 });
    expect(firstLoss(straightPath(a), straightPath(b))).not.toBeNull();
    expect(firstLoss(straightPath(a), straightPath(b), { latNm: 1.5, vertFt: 1000 })).toBeNull();
    expect(firstLoss(straightPath(a), straightPath(b), { latNm: 3, vertFt: 300 })).toBeNull();
    expect(firstLoss(straightPath(a), straightPath(b), { latNm: 0, vertFt: 0 })).toBeNull();
  });
});
