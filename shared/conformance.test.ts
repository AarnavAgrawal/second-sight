import { describe, expect, test } from "bun:test";
import { clearanceWindow, evaluateConformance, formatAltitude } from "./conformance.ts";
import { T0, clearance, pos } from "./test-utils.ts";

const S = 1000;

describe("formatAltitude / clearanceWindow", () => {
  test("formats feet and flight levels", () => {
    expect(formatAltitude(4000)).toBe("4,000");
    expect(formatAltitude(17500)).toBe("17,500");
    expect(formatAltitude(23000)).toBe("FL230");
    expect(formatAltitude(7826)).toBe("7,800");
  });
  test("grace and deadline", () => {
    expect(clearanceWindow("altitude", 0)).toEqual({ graceUntil: 20000, deadlineAt: 60000 });
    expect(clearanceWindow("heading", 0)).toEqual({ graceUntil: 15000, deadlineAt: 45000 });
  });
});

describe("altitude conformance", () => {
  const c = clearance({ kind: "altitude", value: 4000 });
  const at = (t: number, over = {}) => [pos({ ts: T0 + t, ...over })];

  test("climbing aircraft cleared lower: pending during grace", () => {
    const r = evaluateConformance(c, at(10 * S, { altFt: 7800, vertRateFpm: 1800 }), T0 + 10 * S, 13);
    expect(r.status).toBe("pending");
  });

  test("climbing aircraft cleared lower: non_conforming after grace", () => {
    const r = evaluateConformance(c, at(25 * S, { altFt: 7800, vertRateFpm: 1800 }), T0 + 25 * S, 13);
    expect(r).toEqual({ status: "non_conforming", reason: "Cleared to 4,000. Now 7,800 and climbing 1,800 fpm." });
  });

  test("moving toward the cleared altitude fast: conforming", () => {
    const r = evaluateConformance(c, at(5 * S, { altFt: 7800, vertRateFpm: -1800 }), T0 + 5 * S, 13);
    expect(r).toEqual({ status: "conforming", reason: "Cleared to 4,000. Now 7,800, descending 1,800 fpm." });
    const up = clearance({ kind: "altitude", value: 10000 });
    expect(evaluateConformance(up, at(5 * S, { altFt: 7800, vertRateFpm: 1800 }), T0 + 5 * S, 13)).toEqual({
      status: "conforming",
      reason: "Cleared to 10,000. Now 7,800, climbing 1,800 fpm.",
    });
  });

  test("within 300 ft: conforming", () => {
    const r = evaluateConformance(c, at(30 * S, { altFt: 4100, vertRateFpm: 0 }), T0 + 30 * S, 13);
    expect(r).toEqual({ status: "conforming", reason: "Cleared to 4,000. Now 4,100, level." });
  });

  test("level, no progress: pending before deadline, non_conforming after", () => {
    expect(evaluateConformance(c, at(30 * S, { altFt: 7800 }), T0 + 30 * S, 13).status).toBe("pending");
    const r = evaluateConformance(c, at(61 * S, { altFt: 7800 }), T0 + 61 * S, 13);
    expect(r).toEqual({ status: "non_conforming", reason: "Cleared to 4,000. Now 7,800, no change after 60 s." });
  });

  test("flight levels in reasons", () => {
    const fl = clearance({ kind: "altitude", value: 24000 });
    const r = evaluateConformance(fl, at(25 * S, { altFt: 30000, vertRateFpm: 2000 }), T0 + 25 * S, 0);
    expect(r.reason).toBe("Cleared to FL240. Now FL300 and climbing 2,000 fpm.");
  });

  test("coasting when the latest position is older than 30 s", () => {
    const r = evaluateConformance(c, at(0, { altFt: 7800 }), T0 + 31 * S, 13);
    expect(r.status).toBe("coasting");
  });

  test("no positions: pending in grace, coasting after", () => {
    expect(evaluateConformance(c, [], T0 + 5 * S, 13).status).toBe("pending");
    expect(evaluateConformance(c, [], T0 + 25 * S, 13).status).toBe("coasting");
  });
});

describe("heading conformance (13 deg east declination)", () => {
  const DECL = 13;
  const c = clearance({ kind: "heading", value: 270 });
  const track = (tAt: number, prevTrue: number, nowTrue: number) => [
    pos({ ts: T0 + tAt - 5 * S, trackTrueDeg: prevTrue }),
    pos({ ts: T0 + tAt, trackTrueDeg: nowTrue }),
  ];

  test("magnetic track within 20 deg: conforming", () => {
    // True 283 = magnetic 270.
    const r = evaluateConformance(c, track(20 * S, 283, 283), T0 + 20 * S, DECL);
    expect(r).toEqual({ status: "conforming", reason: "Cleared heading 270. Now tracking 270." });
    // True 300 = magnetic 287: within 20 deg.
    expect(evaluateConformance(c, track(20 * S, 300, 300), T0 + 20 * S, DECL).status).toBe("conforming");
  });

  test("not turning: pending in grace, non_conforming after", () => {
    expect(evaluateConformance(c, track(10 * S, 330, 330), T0 + 10 * S, DECL).status).toBe("pending");
    const r = evaluateConformance(c, track(20 * S, 330, 330), T0 + 20 * S, DECL);
    expect(r).toEqual({ status: "non_conforming", reason: "Cleared heading 270. Now tracking 317, not turning." });
  });

  test("turning toward the cleared heading: conforming", () => {
    const r = evaluateConformance(c, track(20 * S, 345, 330), T0 + 20 * S, DECL);
    expect(r).toEqual({ status: "conforming", reason: "Cleared heading 270. Now tracking 317, turning left." });
  });

  test("turning the wrong way for the cleared direction: non_conforming", () => {
    const right = clearance({ kind: "heading", value: 270, turn: "right" });
    // Turning left toward 270 (shorter) but cleared right turn.
    const r = evaluateConformance(right, track(20 * S, 345, 330), T0 + 20 * S, DECL);
    expect(r.status).toBe("non_conforming");
    expect(r.reason).toBe("Cleared heading 270. Now tracking 317, turning left.");
  });

  test("still outside 20 deg at the deadline: non_conforming", () => {
    const r = evaluateConformance(c, track(46 * S, 345, 330), T0 + 46 * S, DECL);
    expect(r).toEqual({
      status: "non_conforming",
      reason: "Cleared heading 270. Now tracking 317, still turning after 45 s.",
    });
  });

  test("positions too far apart do not count as turning", () => {
    const tr = [pos({ ts: T0, trackTrueDeg: 345 }), pos({ ts: T0 + 25 * S, trackTrueDeg: 330 })];
    expect(evaluateConformance(c, tr, T0 + 25 * S, DECL).reason).toContain("not turning");
  });
});
