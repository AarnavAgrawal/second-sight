import { describe, expect, test } from "bun:test";
import { SFO, offset, pos } from "../../../shared/test-utils.ts";
import type { Candidate, Directive, Position, Sector, TrafficEntry } from "../../../shared/types.ts";
import type { AirspaceView } from "../view.ts";
import { findCandidate, pointOutPrecheck, putCandidate, type CandidateMap, type CandidateRef } from "./facts.ts";

const ref = (id: string, callsign: string, hex: string, over: Partial<Candidate> = {}): CandidateRef => ({
  id,
  kind: "altitude",
  value: 7000,
  phraseology: "x",
  deviation: 1000,
  tags: [],
  callsign,
  hex,
  ...over,
});

describe("candidate keys", () => {
  test("qualified and plain ids both resolve; ambiguous plain ids are refused", () => {
    const m: CandidateMap = new Map();
    putCandidate(m, "UAL123:c1", ref("c1", "UAL123", "a1"));
    putCandidate(m, "DAL456:c1", ref("c1", "DAL456", "b2", { value: 9000 }));
    putCandidate(m, "DAL456:c2", ref("c2", "DAL456", "b2", { value: 5000 }));
    expect(findCandidate(m, "UAL123:c1").ok).toBe(true);
    expect(findCandidate(m, "ual 123:c1").ok).toBe(true);
    const c2 = findCandidate(m, "c2");
    expect(c2.ok && c2.candidate.value).toBe(5000);
    expect(findCandidate(m, "c1").ok).toBe(false);
    expect(findCandidate(m, "c9").ok).toBe(false);
    expect(findCandidate(m, undefined).ok).toBe(false);
  });

  test("a different clearance under a taken key gets a suffixed key; the same one reuses it", () => {
    const m: CandidateMap = new Map();
    expect(putCandidate(m, "UAL123:c1", ref("c1", "UAL123", "a1"))).toBe("UAL123:c1");
    expect(putCandidate(m, "UAL123:c1", ref("c1", "UAL123", "a1"))).toBe("UAL123:c1");
    expect(putCandidate(m, "UAL123:c1", ref("c1", "UAL123", "a1", { value: 8000 }))).toBe("UAL123:c1-2");
    expect(m.size).toBe(2);
  });
});

const entry = (p: Position): TrafficEntry => ({
  hex: p.hex,
  callsign: p.callsign,
  typeCode: p.typeCode,
  lat: p.lat,
  lon: p.lon,
  altFt: p.altFt,
  vertRateFpm: p.vertRateFpm,
  gsKt: p.gsKt,
  trackTrueDeg: p.trackTrueDeg,
  status: "none",
  sector: null,
  ca: false,
  ts: p.ts,
  seenSec: p.seenSec,
});

function view(ps: Position[], tc: Record<string, Sector>, directives: Directive[] = []): AirspaceView {
  return {
    airport: SFO,
    session: 1,
    traffic: ps.map(entry),
    positions: ps,
    trackControl: tc,
    handoffs: [],
    conflicts: [],
    statuses: {},
    agreements: [],
    directives,
    clearanceLog: [],
  };
}

describe("pointOutPrecheck", () => {
  const me = pos({ hex: "a00001", callsign: "UAL123", lat: SFO.lat - 0.05, altFt: 6000, vertRateFpm: 0, trackTrueDeg: 0, gsKt: 240 });
  test("clear when no traffic of mine is near the cleared path", () => {
    const far = offset(me, 90, 20, { hex: "b00002", callsign: "DAL456", altFt: 6000, vertRateFpm: 0, trackTrueDeg: 0, gsKt: 240 });
    const r = pointOutPrecheck(view([me, far], { a00001: "SOUTH", b00002: "NORTH" }), "NORTH", "a00001", { kind: "altitude", value: 6000 });
    expect(r.clear).toBe(true);
  });
  test("lists my traffic on the cleared path", () => {
    const ahead = offset(me, 0, 4, { hex: "b00002", callsign: "DAL456", altFt: 6000, vertRateFpm: 0, trackTrueDeg: 180, gsKt: 240 });
    const r = pointOutPrecheck(view([me, ahead], { a00001: "SOUTH", b00002: "NORTH" }), "NORTH", "a00001", { kind: "altitude", value: 6000 });
    expect(r.clear).toBe(false);
    expect(r.traffic[0]?.callsign).toBe("DAL456");
  });
  test("ignores traffic the other sector controls", () => {
    const ahead = offset(me, 0, 4, { hex: "b00002", callsign: "DAL456", altFt: 6000, vertRateFpm: 0, trackTrueDeg: 180, gsKt: 240 });
    const r = pointOutPrecheck(view([me, ahead], { a00001: "SOUTH", b00002: "SOUTH" }), "NORTH", "a00001", { kind: "altitude", value: 6000 });
    expect(r.clear).toBe(true);
  });
  test("an altitude cap directive forbids a higher altitude", () => {
    const d: Directive = { id: "d1", target: "ALL", text: "Nothing above eight thousand", rule: { type: "altitude_cap", value: 8000 }, createdAt: 0, expiresAt: Date.now() + 60_000, state: "active" };
    const r = pointOutPrecheck(view([me], { a00001: "SOUTH" }, [d]), "NORTH", "a00001", { kind: "altitude", value: 10000 });
    expect(r.clear).toBe(false);
    expect(r.blocking).toHaveLength(1);
  });
});
