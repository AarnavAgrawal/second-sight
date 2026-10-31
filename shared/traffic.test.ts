// Tests for mergeTraffic: track control assignment and coasting tracks.
import { describe, expect, test } from "bun:test";
import { COAST_DROP_MS, mergeTraffic, type MergeTrafficInput } from "./traffic.ts";
import { SFO, T0, pos } from "./test-utils.ts";
import type { Position, TrafficEntry } from "./types.ts";

const north = (over: Partial<Position> = {}) => pos({ lat: SFO.lat + 0.2, ...over });
const south = (over: Partial<Position> = {}) => pos({ lat: SFO.lat - 0.2, ...over });

function input(over: Partial<MergeTrafficInput>): MergeTrafficInput {
  return {
    airport: SFO,
    batch: [],
    prevTraffic: [],
    trackControl: {},
    statuses: {},
    pendingHandoffHex: new Set(),
    caHex: new Set(),
    now: T0,
    ...over,
  };
}

/** Run one merge with `batch` and return the traffic it produced (to seed the next merge). */
const seed = (batch: Position[], over: Partial<MergeTrafficInput> = {}): TrafficEntry[] => mergeTraffic(input({ batch, ...over })).traffic;

describe("mergeTraffic: track control", () => {
  test("assigns new aircraft by geometry", () => {
    const r = mergeTraffic(input({ batch: [north({ hex: "n1" }), south({ hex: "s1" })] }));
    expect(r.trackControl).toEqual({ n1: "NORTH", s1: "SOUTH" });
    expect(r.traffic.map((t) => t.sector)).toEqual(["NORTH", "SOUTH"]);
  });

  test("keeps the existing owner even across the line", () => {
    const r = mergeTraffic(input({ batch: [south({ hex: "n1" })], trackControl: { n1: "NORTH" } }));
    expect(r.trackControl.n1).toBe("NORTH");
  });

  test("no owner by geometry while a handoff is pending", () => {
    const r = mergeTraffic(input({ batch: [north({ hex: "n1" })], pendingHandoffHex: new Set(["n1"]) }));
    expect(r.trackControl.n1).toBeUndefined();
    expect(r.traffic[0]!.sector).toBeNull();
  });

  test("marks CA and merges status", () => {
    const r = mergeTraffic(
      input({ batch: [north({ hex: "n1" })], caHex: new Set(["n1"]), statuses: { n1: { status: "pending", reason: "" } } }),
    );
    expect(r.traffic[0]!.ca).toBe(true);
    expect(r.traffic[0]!.status).toBe("pending");
  });
});

describe("mergeTraffic: coasting", () => {
  const a = north({ hex: "c1", callsign: "SWA2140", ts: T0 });
  const b = south({ hex: "b1", callsign: "DAL456", ts: T0 });
  const prev = seed([a, b]);
  const tc = { c1: "NORTH", b1: "SOUTH" } as const;

  test("aircraft without an active clearance is dropped immediately", () => {
    const r = mergeTraffic(input({ batch: [a], prevTraffic: prev, trackControl: { ...tc }, now: T0 + 5_000 }));
    expect(r.traffic.map((t) => t.hex)).toEqual(["c1"]);
    expect(r.trackControl).toEqual({ c1: "NORTH" });
    expect(r.present.has("b1")).toBe(false);
  });

  test("aircraft with an active clearance coasts with its last entry and keeps track control", () => {
    const statuses = { c1: { status: "conforming" as const, reason: "On altitude." } };
    const r = mergeTraffic(input({ batch: [b], prevTraffic: prev, trackControl: { ...tc }, statuses, now: T0 + 32_000 }));
    const c = r.traffic.find((t) => t.hex === "c1")!;
    expect(c).toBeDefined();
    expect(c.status).toBe("coasting");
    expect(c.sector).toBe("NORTH");
    expect(c.lat).toBe(a.lat);
    expect(c.ts).toBe(T0);
    expect(r.trackControl.c1).toBe("NORTH");
    expect(r.statuses.c1).toEqual({ status: "coasting", reason: "No position for 32 s." });
    expect(r.startedCoasting).toEqual(["c1"]);
    expect(r.present.has("c1")).toBe(true);
    // input not mutated
    expect(statuses.c1.status).toBe("conforming");
  });

  test("already coasting: reason is not rewritten, entry stays until 60 s after last ts", () => {
    const statuses = { c1: { status: "coasting" as const, reason: "No position for 30 s." } };
    const coasting = mergeTraffic(input({ batch: [b], prevTraffic: prev, trackControl: { ...tc }, statuses: { c1: { status: "pending", reason: "" } }, now: T0 + 30_000 })).traffic;
    const r = mergeTraffic(input({ batch: [b], prevTraffic: coasting, trackControl: { ...tc }, statuses, now: T0 + COAST_DROP_MS - 1 }));
    expect(r.traffic.some((t) => t.hex === "c1")).toBe(true);
    expect(r.statuses).toBe(statuses); // unchanged object, nothing to persist
    expect(r.startedCoasting).toEqual([]);
  });

  test("dropped 60 s after last ts, with track control and status", () => {
    const statuses = { c1: { status: "coasting" as const, reason: "No position for 30 s." }, b1: { status: "pending" as const, reason: "" } };
    const r = mergeTraffic(input({ batch: [b], prevTraffic: prev, trackControl: { ...tc }, statuses, now: T0 + COAST_DROP_MS }));
    expect(r.traffic.map((t) => t.hex)).toEqual(["b1"]);
    expect(r.trackControl).toEqual({ b1: "SOUTH" });
    expect(r.statuses).toEqual({ b1: { status: "pending", reason: "" } });
    expect(r.dropped).toEqual(["c1"]);
  });

  test("reappearing aircraft uses the fresh position", () => {
    const statuses = { c1: { status: "coasting" as const, reason: "No position for 30 s." } };
    const fresh = north({ hex: "c1", callsign: "SWA2140", lat: SFO.lat + 0.25, ts: T0 + 40_000 });
    const r = mergeTraffic(input({ batch: [fresh, b], prevTraffic: prev, trackControl: { ...tc }, statuses, now: T0 + 40_000 }));
    const c = r.traffic.filter((t) => t.hex === "c1");
    expect(c).toHaveLength(1);
    expect(c[0]!.lat).toBe(fresh.lat);
    expect(r.trackControl.c1).toBe("NORTH");
  });
});

describe("mergeTraffic: isVfr", () => {
  test("carries isVfr into the traffic list (false when the position has none)", () => {
    const r = mergeTraffic(input({ batch: [north({ hex: "v1", isVfr: true }), south({ hex: "i1", isVfr: false }), south({ hex: "x1" })] }));
    expect(r.traffic.map((t) => [t.hex, t.isVfr])).toEqual([
      ["v1", true],
      ["i1", false],
      ["x1", false],
    ]);
  });
});
