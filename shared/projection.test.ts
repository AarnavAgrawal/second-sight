// Tests for projection.ts: pathFor (traffic flying a clearance), intentsFromLog, liveSeparationContext,
// and their effect on the probe and the conflict alert.
import { describe, expect, test } from "bun:test";
import { haversineNm } from "./geo.ts";
import { probeClearance } from "./probe.ts";
import { intentsFromLog, liveSeparationContext, pathFor, projectClearedPath, straightPath } from "./projection.ts";
import { conflictAlert } from "./separation.ts";
import { SFO, T0, offset, pos } from "./test-utils.ts";

describe("pathFor", () => {
  const p = pos({ altFt: 6000, trackTrueDeg: 90, vertRateFpm: 0 });
  const hdg = { kind: "heading" as const, value: 360, turn: "left" as const };
  const alt = { kind: "altitude" as const, value: 9000 };
  test("no intent: straight", () => {
    expect(pathFor(p, undefined, 13)).toEqual(straightPath(p));
    expect(pathFor(p, {}, 13)).toEqual(straightPath(p));
  });
  test("heading intent: the heading turn model", () => {
    expect(pathFor(p, { heading: hdg }, 13)).toEqual(projectClearedPath(p, hdg, 13));
  });
  test("altitude intent: the vertical profile toward the cleared altitude", () => {
    const path = pathFor(p, { altitude: alt }, 13);
    expect(path).toEqual(projectClearedPath(p, alt, 13));
    expect(path[12]!.altFt).toBe(9000);
  });
  test("both: lateral from the heading path, altitude from the altitude path", () => {
    const both = pathFor(p, { heading: hdg, altitude: alt }, 13);
    const h = projectClearedPath(p, hdg, 13);
    const a = projectClearedPath(p, alt, 13);
    both.forEach((pt, i) => {
      expect(pt.lat).toBe(h[i]!.lat);
      expect(pt.lon).toBe(h[i]!.lon);
      expect(pt.altFt).toBe(a[i]!.altFt);
    });
  });
  test("already within 30 degrees of the heading: finishes the short way, not a 330 degree turn", () => {
    // Magnetic track 312 (true 325, decl 13); "turn left heading 316" would be a 356 degree left turn.
    const q = pos({ trackTrueDeg: 325 });
    const path = pathFor(q, { heading: { kind: "heading", value: 316, turn: "left" } }, 13);
    const end = path[path.length - 1]!;
    // A 356 degree orbit would end near the start; the short turn keeps going (~8.3 NM in 120 s at 250 kt).
    expect(haversineNm(q.lat, q.lon, end.lat, end.lon)).toBeGreaterThan(8);
    const literal = projectClearedPath(q, { kind: "heading", value: 316, turn: "left" }, 13)[12]!;
    expect(haversineNm(q.lat, q.lon, literal.lat, literal.lon)).toBeLessThan(2);
  });
});

describe("intentsFromLog", () => {
  const e = (hex: string, kind: "altitude" | "heading", value: number, dtSec: number) => ({ hex, kind, value, ts: T0 + dtSec * 1000 });
  test("latest entry per aircraft per kind within the window", () => {
    const m = intentsFromLog([e("a", "altitude", 5000, -100), e("a", "altitude", 6000, -50), e("a", "heading", 270, -30), e("b", "heading", 90, -10)], T0);
    expect(m.get("a")).toEqual({ altitude: { kind: "altitude", value: 6000 }, heading: { kind: "heading", value: 270 } });
    expect(m.get("b")).toEqual({ heading: { kind: "heading", value: 90 } });
  });
  test("drops entries older than the window and in the future", () => {
    const m = intentsFromLog([e("a", "altitude", 5000, -121), e("b", "altitude", 7000, 5), e("c", "heading", 180, -120)], T0);
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(false);
    expect(m.get("c")).toEqual({ heading: { kind: "heading", value: 180 } });
    expect(intentsFromLog([e("a", "altitude", 5000, -200)], T0, 300).has("a")).toBe(true);
  });
  test("keeps the turn direction", () => {
    const m = intentsFromLog([{ hex: "a", kind: "heading", value: 310, turn: "left", ts: T0 }], T0);
    expect(m.get("a")?.heading).toEqual({ kind: "heading", value: 310, turn: "left" });
  });
});

describe("liveSeparationContext", () => {
  test("intents from the clearance log, minus non_conforming and coasting aircraft; never visual", () => {
    const log = ["a", "b", "c"].map((hex) => ({ hex, kind: "altitude" as const, value: 5000, ts: T0 - 10_000 }));
    const ctx = liveSeparationContext(log, { b: { status: "non_conforming" }, c: { status: "coasting" }, a: { status: "pending" } }, T0);
    expect([...ctx.intents!.keys()]).toEqual(["a"]);
    expect(ctx.visualHex!.size).toBe(0);
  });
});

describe("traffic being vectored away", () => {
  // UAL1 eastbound at 8,000; DAL2 10 NM ahead westbound at 8,000: head-on in a straight line.
  const a = pos({ hex: "aaa001", callsign: "UAL1", altFt: 8000, trackTrueDeg: 90, gsKt: 250 });
  const b = offset(a, 90, 10, { hex: "bbb002", callsign: "DAL2", altFt: 8000, trackTrueDeg: 270, gsKt: 250 });
  const ctx = { intents: new Map([["bbb002", { heading: { kind: "heading" as const, value: 360, turn: "right" as const } }]]) };
  test("probe: conflicts straight-line, clean once DAL2 flies its heading", () => {
    expect(probeClearance(a, { kind: "altitude", value: 8000 }, [a, b], SFO).ok).toBe(false);
    expect(probeClearance(a, { kind: "altitude", value: 8000 }, [a, b], SFO, ctx).ok).toBe(true);
  });
  test("conflict alert: same", () => {
    expect(conflictAlert([a, b], SFO)).toHaveLength(1);
    expect(conflictAlert([a, b], SFO, ctx)).toEqual([]);
  });
  test("an altitude intent counts too: DAL2 descending to 5,000 clears it", () => {
    const down = { intents: new Map([["bbb002", { altitude: { kind: "altitude" as const, value: 5000 } }]]) };
    // 1,500 fpm minimum model: 1,000 ft below in 40 s, they meet at ~72 s.
    expect(conflictAlert([a, b], SFO, down)).toEqual([]);
  });
});
