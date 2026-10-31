import { describe, expect, test } from "bun:test";
import { projectStraight } from "../../../shared/projection.ts";
import type { HeardTransmission, Position } from "../../../shared/types.ts";
import { evaluate, heardContext, intentLog, judgeOutcome, plausibleClearance, visualLog } from "./evaluate.ts";

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

describe("evaluate kpis", () => {
  // Scripted recording: 300 s of snapshots every 10 s, straight-line flight.
  const SFO = { icao: "KSFO", name: "SFO", city: "", state: "CA", lat: 37.619, lon: -122.375, elevationFt: 13, radiusNm: 35, declinationDeg: 13 };
  const mk = (hex: string, callsign: string, lat: number, lon: number, altFt: number, trackTrueDeg: number, vertRateFpm: number): Position => ({
    hex, callsign, registration: null, typeCode: "B738", lat, lon, altFt, gsKt: 250, trackTrueDeg, vertRateFpm, seenSec: 0, ts: T0, squawk: "4000", isVfr: false,
  });
  const at = (p: Position, t: number): Position => {
    const q = projectStraight(p, t);
    return { ...p, lat: q.lat, lon: q.lon, altFt: q.altFt, ts: T0 + t * 1000 };
  };
  const levelAt = (p: Position, alt: number, t: number): Position => {
    const q = at(p, t);
    const reached = p.vertRateFpm < 0 ? q.altFt! <= alt : q.altFt! >= alt;
    return reached ? { ...q, altFt: alt, vertRateFpm: 0 } : q;
  };
  // A: descending to 6,000, reaches it at 120 s (complied). B: slow descent toward 4,000 (in progress).
  // C: level at 7,000, cleared to 9,000 (no change). D/E: head-on at 8,000 (D cleared to stay at 8,000: unable, and they do pass close).
  const A = mk("a00001", "UAL1", 38.1, -122.9, 8000, 90, -1000);
  const B = mk("b00001", "UAL2", 38.25, -122.9, 12000, 90, -300);
  const C = mk("c00001", "UAL3", 38.4, -122.9, 7000, 90, 0);
  const D = mk("d00001", "UAL4", 37.95, -123.2, 8000, 90, 0);
  const E = { ...mk("e00001", "DAL5", 37.95, -123.2, 8000, 270, 0) };
  const eStart = (() => {
    const q = projectStraight({ ...D, trackTrueDeg: 90 }, (8 / 500) * 3600 * 2); // 8 NM east of D
    return { ...E, lat: q.lat, lon: q.lon };
  })();
  const snapshots = Array.from({ length: 31 }, (_, i) => {
    const t = i * 10;
    return { ts: T0 + t * 1000, positions: [levelAt(A, 6000, t), at(B, t), at(C, t), at(D, t), at(eStart, t)] };
  });
  const heard = (id: string, hex: string, callsign: string, value: number): HeardTransmission => ({
    id, feed: "test", ts: T0 + 5000, durSec: 2, text: `${callsign} maintain ${value}`, speaker: "controller", callsign, hex,
    clearances: [{ kind: "altitude", value }], note: null,
  });
  const report = evaluate({
    icao: "KSFO",
    airport: SFO,
    snapshots,
    heard: [heard("1", A.hex, A.callsign, 6000), heard("2", B.hex, B.callsign, 4000), heard("3", C.hex, C.callsign, 9000), heard("4", D.hex, D.callsign, 8000)],
    fromTs: T0,
    toTs: T0 + 300_000,
  });
  const byCs = (cs: string) => report.clearances.find((c) => c.callsign === cs)!;

  test("outcomes and rulings", () => {
    expect(byCs("UAL1").outcome.result).toBe("complied");
    expect(byCs("UAL2").outcome.result).toBe("in_progress");
    expect(byCs("UAL3").outcome.result).toBe("no_change");
    expect(byCs("UAL4").ruling?.decision).toBe("unable");
    expect(byCs("UAL4").ruling?.conflicts[0]?.with).toBe("DAL5");
  });
  test("would issue / observed / agreed (observed) / in progress / unable actually close", () => {
    const k = report.kpis;
    expect(k.ruled).toBe(4);
    expect(k.wouldIssue).toBe(3);
    expect(k.unable).toBe(1);
    expect(k.observed).toBe(3); // complied, no_change, and the unable one (already at 8,000)
    expect(k.agreedObserved).toBe(1);
    expect(k.inProgress).toBe(1);
    expect(k.unableActuallyClose).toBe(1);
    expect(byCs("UAL4").actualSeparation?.inside).toBe(true);
  });
});

describe("heard context", () => {
  const h = (over: Partial<HeardTransmission>): HeardTransmission => ({
    id: Math.random().toString(36), feed: "test", ts: T0, durSec: 2, text: "", speaker: "controller", callsign: "UAL1", hex: "a00001", clearances: [], note: null, ...over,
  });
  test("visual separation: pilot traffic in sight and controller 'maintain visual separation' count; a request to report does not", () => {
    const v = visualLog([
      h({ speaker: "pilot", text: "Traffic in sight, New Zealand eight", hex: "c820ce" }),
      h({ text: "SkyWest forty-seven ninety, maintain visual separation, cleared visual approach", hex: "ad97dd" }),
      h({ text: "United one, traffic two o'clock, report traffic in sight", hex: "a00009" }),
      h({ speaker: "pilot", text: "Traffic in sight", hex: null }),
    ]);
    expect(v.map((x) => x.hex)).toEqual(["c820ce", "ad97dd"]);
  });
  test("intents: controller clearances in the previous 120 s; visual: previous 5 minutes", () => {
    const heard = [
      h({ ts: T0 - 130_000, clearances: [{ kind: "altitude", value: 5000 }] }),
      h({ ts: T0 - 60_000, clearances: [{ kind: "heading", value: 270, turn: "left" }] }),
      h({ ts: T0 - 60_000, speaker: "pilot", clearances: [{ kind: "altitude", value: 9000 }] }),
      h({ ts: T0 - 250_000, speaker: "pilot", text: "we have the traffic", hex: "b00002" }),
      h({ ts: T0 - 400_000, speaker: "pilot", text: "traffic in sight", hex: "c00003" }),
    ];
    const ctx = heardContext(intentLog(heard), visualLog(heard), T0);
    expect(ctx.intents!.get("a00001")).toEqual({ heading: { kind: "heading", value: 270, turn: "left" } });
    expect([...ctx.visualHex!]).toEqual(["b00002"]);
  });
});
