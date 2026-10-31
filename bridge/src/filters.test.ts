import { describe, expect, test } from "bun:test";
import { destination } from "../../shared/geo.ts";
import { SFO, T0, pos } from "../../shared/test-utils.ts";
import type { Position } from "../../shared/types.ts";
import {
  boundaryGate,
  caPairAllowed,
  discreteSquawkSet,
  dropShadows,
  squawkSet,
  HANDOFF_RETRY_AFTER_MS,
  latestHandoffByHex,
  type HandoffLike,
} from "./filters.ts";

/** Position `distNm` from the field along true `bearing`. */
const at = (bearing: number, distNm: number, over: Partial<Position> = {}) => {
  const d = destination(SFO.lat, SFO.lon, bearing, distNm);
  return pos({ ...over, lat: d.lat, lon: d.lon });
};

describe("dropShadows", () => {
  const real = pos({ hex: "a1b2c3", altFt: 5000 });
  test("drops a ~hex target that duplicates a real one (< 0.5 NM, < 300 ft)", () => {
    const shadow = pos({ hex: "~a1b2c3", altFt: 5100, lat: real.lat + 0.001 });
    expect(dropShadows([real, shadow]).map((p) => p.hex)).toEqual(["a1b2c3"]);
  });
  test("keeps a ~hex target with no real twin", () => {
    const far = pos({ hex: "~zz", lat: real.lat + 0.2 });
    const high = pos({ hex: "~yy", altFt: 6000 });
    expect(dropShadows([real, far, high]).map((p) => p.hex)).toEqual(["a1b2c3", "~zz", "~yy"]);
  });
  test("never drops real ICAO targets", () => {
    const twin = pos({ hex: "d4e5f6" });
    expect(dropShadows([real, twin])).toHaveLength(2);
  });
});

describe("discreteSquawkSet", () => {
  test("keeps known non-VFR squawks, lowercases hex", () => {
    const s = discreteSquawkSet([
      { hex: "A1B2C3", squawk: "4521" },
      { hex: "vfr1", squawk: "1200" },
      { hex: "none" },
      { hex: "nul", squawk: null },
      { hex: "num", squawk: 7000 },
      { squawk: "4000" },
    ]);
    expect([...s].sort()).toEqual(["a1b2c3", "num"]);
  });
});

describe("squawkSet", () => {
  test("keeps every squawked target including VFR 1200, drops targets with no squawk", () => {
    const s = squawkSet([
      { hex: "A1B2C3", squawk: "4521" },
      { hex: "vfr1", squawk: "1200" },
      { hex: "none" },
      { hex: "nul", squawk: null },
      { hex: "blank", squawk: "" },
      { squawk: "4000" },
    ]);
    expect([...s].sort()).toEqual(["a1b2c3", "vfr1"]);
  });
});

describe("caPairAllowed", () => {
  const FLOOR = 2500;
  test("near the field above the floor: allowed (final approach suppression is the shared pair rule's job)", () => {
    expect(caPairAllowed(at(280, 3, { altFt: 2800 }), at(100, 3, { altFt: 2900 }), SFO, 1000)).toBe(true);
  });
  test("both below the CA floor: not alerted", () => {
    expect(caPairAllowed(at(0, 20, { altFt: 2000 }), at(0, 21, { altFt: 2400 }), SFO, FLOOR)).toBe(false);
  });
  test("one above the CA floor: alerted", () => {
    expect(caPairAllowed(at(0, 20, { altFt: 2000 }), at(0, 21, { altFt: 3000 }), SFO, FLOOR)).toBe(true);
  });
  test("focus: at least one aircraft must be a focus callsign", () => {
    const a = at(0, 20, { callsign: "SIM1", altFt: 8000 });
    const b = at(0, 21, { callsign: "UAL1", altFt: 8000 });
    const c = at(0, 22, { callsign: "DAL2", altFt: 8000 });
    const focus = new Set(["SIM1"]);
    expect(caPairAllowed(a, b, SFO, FLOOR, focus)).toBe(true);
    expect(caPairAllowed(b, c, SFO, FLOOR, focus)).toBe(false);
    expect(caPairAllowed(b, c, SFO, FLOOR, null)).toBe(true);
  });
});

describe("boundaryGate", () => {
  const ho = (state: string, over: Partial<HandoffLike> = {}): HandoffLike => ({ hex: "a1", from: "NORTH", state, dueAt: T0, ...over });
  const gate = (over: Partial<Parameters<typeof boundaryGate>[0]>) =>
    boundaryGate({ owner: "NORTH", emitted: false, retried: false, handoff: undefined, now: T0, ...over });

  test("first crossing emits once", () => {
    expect(gate({})).toBe("emit");
    expect(gate({ emitted: true })).toBe("skip");
  });
  test("pending handoff: skip", () => {
    expect(gate({ handoff: ho("pending") })).toBe("skip");
  });
  test("accepted handoff from the other owner does not block a new crossing", () => {
    expect(gate({ handoff: ho("accepted", { from: "SOUTH" }) })).toBe("emit");
  });
  for (const state of ["overdue", "unable"]) {
    test(`${state}: retry once, ${HANDOFF_RETRY_AFTER_MS / 1000} s after dueAt`, () => {
      const h = ho(state);
      expect(gate({ emitted: true, handoff: h, now: T0 + HANDOFF_RETRY_AFTER_MS - 1 })).toBe("skip");
      expect(gate({ emitted: true, handoff: h, now: T0 + HANDOFF_RETRY_AFTER_MS })).toBe("retry");
      expect(gate({ emitted: true, retried: true, handoff: h, now: T0 + 10 * HANDOFF_RETRY_AFTER_MS })).toBe("skip");
    });
  }
  test("overdue handoff from another owner stays open: skip", () => {
    expect(gate({ owner: "SOUTH", handoff: ho("overdue", { from: "NORTH" }), now: T0 + 120_000 })).toBe("skip");
  });
  test("unable from another owner does not block", () => {
    expect(gate({ owner: "SOUTH", handoff: ho("unable", { from: "NORTH" }) })).toBe("emit");
  });
});

describe("latestHandoffByHex", () => {
  test("later entries win", () => {
    const m = latestHandoffByHex([
      { hex: "a", state: "unable" },
      { hex: "b", state: "accepted" },
      { hex: "a", state: "pending" },
    ]);
    expect(m.get("a")!.state).toBe("pending");
    expect(m.get("b")!.state).toBe("accepted");
  });
});
