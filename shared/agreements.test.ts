import { describe, expect, test } from "bun:test";
import {
  activeAgreements,
  agreementFromCandidate,
  checkAgreements,
  recentConflictingClearance,
} from "./agreements.ts";
import type { Agreement, AgreementConstraint } from "./types.ts";
import { T0, clearance } from "./test-utils.ts";

function agreement(constraint: AgreementConstraint, over: Partial<Agreement> = {}): Agreement {
  return {
    id: "ag1",
    hex: "a00001",
    callsign: "DAL456",
    constraint,
    between: ["NORTH", "SOUTH"],
    source: "APREQ",
    text: "",
    createdAt: T0,
    expiresAt: T0 + 300_000,
    state: "active",
    ...over,
  };
}

const alt = (value: number) => ({ kind: "altitude" as const, value });
const hdg = (value: number, turn?: "left" | "right") => ({ kind: "heading" as const, value, ...(turn ? { turn } : {}) });

describe("activeAgreements", () => {
  test("keeps active, unexpired agreements only", () => {
    const a = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { id: "a" });
    const expiredByTime = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { id: "b", expiresAt: T0 + 10 });
    const cancelled = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { id: "c", state: "cancelled" });
    const expired = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { id: "d", state: "expired" });
    const out = activeAgreements([a, expiredByTime, cancelled, expired], T0 + 10);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("checkAgreements", () => {
  const now = T0 + 1000;
  test("altitude maintain: any other altitude breaks it", () => {
    const ag = agreement({ kind: "altitude", op: "maintain", value: 6000 });
    expect(checkAgreements("a00001", alt(8000), [ag], now)).toEqual([ag]);
    expect(checkAgreements("a00001", alt(6000), [ag], now)).toEqual([]);
  });
  test("altitude at_or_below: higher breaks it", () => {
    const ag = agreement({ kind: "altitude", op: "at_or_below", value: 6000 });
    expect(checkAgreements("a00001", alt(7000), [ag], now)).toHaveLength(1);
    expect(checkAgreements("a00001", alt(6000), [ag], now)).toHaveLength(0);
    expect(checkAgreements("a00001", alt(5000), [ag], now)).toHaveLength(0);
  });
  test("altitude at_or_above: lower breaks it", () => {
    const ag = agreement({ kind: "altitude", op: "at_or_above", value: 6000 });
    expect(checkAgreements("a00001", alt(5000), [ag], now)).toHaveLength(1);
    expect(checkAgreements("a00001", alt(6000), [ag], now)).toHaveLength(0);
    expect(checkAgreements("a00001", alt(9000), [ag], now)).toHaveLength(0);
  });
  test("heading maintain: more than 5 degrees off breaks it (wraps at 360)", () => {
    const ag = agreement({ kind: "heading", op: "maintain", value: 270 });
    expect(checkAgreements("a00001", hdg(290), [ag], now)).toHaveLength(1);
    expect(checkAgreements("a00001", hdg(275), [ag], now)).toHaveLength(0);
    const north = agreement({ kind: "heading", op: "maintain", value: 358 });
    expect(checkAgreements("a00001", hdg(2), [north], now)).toHaveLength(0);
    expect(checkAgreements("a00001", hdg(10), [north], now)).toHaveLength(1);
  });
  test("mixed kinds never break", () => {
    const altAg = agreement({ kind: "altitude", op: "maintain", value: 6000 });
    const hdgAg = agreement({ kind: "heading", op: "maintain", value: 270 }, { id: "ag2" });
    expect(checkAgreements("a00001", hdg(90), [altAg], now)).toEqual([]);
    expect(checkAgreements("a00001", alt(9000), [hdgAg], now)).toEqual([]);
  });
  test("other aircraft, expired and cancelled agreements are ignored", () => {
    const other = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { hex: "b00002" });
    const old = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { expiresAt: now });
    const cancelled = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { state: "cancelled" });
    const expired = agreement({ kind: "altitude", op: "maintain", value: 6000 }, { state: "expired" });
    expect(checkAgreements("a00001", alt(8000), [other, old, cancelled, expired], now)).toEqual([]);
  });
});

describe("agreementFromCandidate", () => {
  test("altitude candidate becomes a maintain constraint with text", () => {
    const a = agreementFromCandidate({
      hex: "a00001",
      callsign: "DAL456",
      candidate: { kind: "altitude", value: 6000 },
      between: ["NORTH", "SOUTH"],
      source: "APREQ",
    });
    expect(a.constraint).toEqual({ kind: "altitude", op: "maintain", value: 6000 });
    expect(a.text).toBe("DAL456 maintain 6,000 (APREQ)");
    expect(a.hex).toBe("a00001");
    expect(a.between).toEqual(["NORTH", "SOUTH"]);
    expect(a.source).toBe("APREQ");
  });
  test("note is included", () => {
    const a = agreementFromCandidate({
      hex: "a00001",
      callsign: "DAL456",
      candidate: { kind: "altitude", value: 6000 },
      between: ["NORTH", "SOUTH"],
      source: "APREQ",
      note: "until clear of JBU811",
    });
    expect(a.text).toBe("DAL456 maintain 6,000 until clear of JBU811 (APREQ)");
  });
  test("flight level and heading text", () => {
    const fl = agreementFromCandidate({
      hex: "a1",
      callsign: "UAL123",
      candidate: { kind: "altitude", value: 24000 },
      between: ["NORTH"],
      source: "CIC",
    });
    expect(fl.text).toBe("UAL123 maintain FL240 (CIC)");
    const h = agreementFromCandidate({
      hex: "a1",
      callsign: "DAL456",
      candidate: { kind: "heading", value: 270, turn: "left" },
      between: ["SOUTH"],
      source: "handoff",
    });
    expect(h.constraint).toEqual({ kind: "heading", op: "maintain", value: 270 });
    expect(h.text).toBe("DAL456 maintain heading 270 (handoff)");
  });
});

describe("recentConflictingClearance", () => {
  test("null when there is no previous clearance", () => {
    expect(recentConflictingClearance(null, alt(8000), 6000, T0)).toBeNull();
  });
  test("altitude reversal: descend then climb", () => {
    const prev = clearance(alt(4000), T0); // descending from 6,000
    const r = recentConflictingClearance(prev, alt(8000), 6000, T0 + 30_000);
    expect(r).not.toBeNull();
    expect(r!.clearance).toBe(prev);
    expect(r!.secondsAgo).toBe(30);
    expect(r!.why).toBe("reverses the descent to 4,000 issued 30 s ago");
  });
  test("altitude change of more than 3,000 ft in the same direction", () => {
    const prev = clearance(alt(8000), T0);
    const r = recentConflictingClearance(prev, alt(11500), 6000, T0 + 20_000);
    expect(r).not.toBeNull();
    expect(r!.why).toBe("3,500 ft from the 8,000 cleared 20 s ago");
  });
  test("heading reversal: left then right", () => {
    const prev = clearance(hdg(270, "left"), T0);
    const r = recentConflictingClearance(prev, hdg(300, "right"), 6000, T0 + 10_000);
    expect(r).not.toBeNull();
    expect(r!.why).toBe("reverses the left turn to heading 270 issued 10 s ago");
  });
  test("heading change of more than 60 degrees", () => {
    const prev = clearance(hdg(270), T0);
    const r = recentConflictingClearance(prev, hdg(180), 6000, T0 + 15_000);
    expect(r).not.toBeNull();
    expect(r!.why).toBe("90 degrees from heading 270 cleared 15 s ago");
  });
  test("older than 60 s returns null", () => {
    const prev = clearance(alt(4000), T0);
    expect(recentConflictingClearance(prev, alt(8000), 6000, T0 + 60_000)).toBeNull();
    expect(recentConflictingClearance(prev, alt(8000), 6000, T0 + 90_000)).toBeNull();
  });
  test("small change in the same direction returns null", () => {
    expect(recentConflictingClearance(clearance(alt(8000), T0), alt(9000), 6000, T0 + 10_000)).toBeNull();
    expect(recentConflictingClearance(clearance(hdg(270, "left"), T0), hdg(250, "left"), 6000, T0 + 10_000)).toBeNull();
  });
  test("mixed kinds return null", () => {
    expect(recentConflictingClearance(clearance(alt(4000), T0), hdg(90), 6000, T0 + 10_000)).toBeNull();
  });
  test("unknown current altitude still catches large changes but not reversals", () => {
    expect(recentConflictingClearance(clearance(alt(5000), T0), alt(7000), null, T0 + 10_000)).toBeNull();
    expect(recentConflictingClearance(clearance(alt(4000), T0), alt(8000), null, T0 + 10_000)).not.toBeNull();
  });
});
