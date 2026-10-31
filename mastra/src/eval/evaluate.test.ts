import { describe, expect, test } from "bun:test";
import type { Position } from "../../../shared/types.ts";
import { judgeOutcome, plausibleClearance } from "./evaluate.ts";

const T0 = 1_800_000_000_000;
const pos = (dtSec: number, altFt: number, trackTrueDeg = 90): Position => ({
  hex: "abc123", callsign: "UAL1", registration: null, typeCode: null, lat: 37.6, lon: -122.4,
  altFt, gsKt: 250, trackTrueDeg, vertRateFpm: 0, seenSec: 0, ts: T0 + dtSec * 1000,
});
const track = (alts: number[], stepSec = 10) => alts.map((a, i) => pos(i * stepSec, a));

describe("judgeOutcome", () => {
  test("altitude reached within the window is complied, with time to reach", () => {
    const o = judgeOutcome({ kind: "altitude", value: 6000 }, T0, track([8000, 7600, 7000, 6400, 6100, 6000]), 0);
    expect(o.result).toBe("complied");
    expect(o.reachedInSec).toBe(40);
  });
  test("moving toward but not there yet is in_progress", () => {
    expect(judgeOutcome({ kind: "altitude", value: 4000 }, T0, track([9000, 8800, 8500, 8200]), 0).result).toBe("in_progress");
  });
  test("moving away is contrary", () => {
    expect(judgeOutcome({ kind: "altitude", value: 4000 }, T0, track([8000, 8400, 8900, 9500]), 0).result).toBe("contrary");
  });
  test("no recorded positions after the clearance is no_data", () => {
    expect(judgeOutcome({ kind: "altitude", value: 4000 }, T0, track([8000]), 0).result).toBe("no_data");
  });
  test("heading within 20 degrees (magnetic) is complied", () => {
    const t = [pos(0, 5000, 90), pos(10, 5000, 120), pos(20, 5000, 150), pos(30, 5000, 175)];
    expect(judgeOutcome({ kind: "heading", value: 180, turn: "right" }, T0, t, 0).result).toBe("complied");
  });
});

describe("plausibleClearance", () => {
  test("rejects speeds parsed as altitudes and odd values", () => {
    expect(plausibleClearance({ kind: "altitude", value: 180 })).toBe(false);
    expect(plausibleClearance({ kind: "altitude", value: 23_550 })).toBe(false);
    expect(plausibleClearance({ kind: "altitude", value: 4000 })).toBe(true);
    expect(plausibleClearance({ kind: "heading", value: 361 })).toBe(false);
  });
});
