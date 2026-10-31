// Pure helpers of the clearance workflow. No actor server, Relay or LLM: importing the module only
// builds the workflow and agent definitions.
import { describe, expect, test } from "bun:test";
import { alternativeOf, ClearanceResultSchema, finish, log, type Flow } from "./clearance.ts";

const base = (over: Partial<Flow> = {}): Flow => ({
  text: "Southwest twenty-one forty, descend and maintain four thousand",
  override: false,
  confirmed: false,
  parsed: null,
  hex: null,
  callsign: null,
  sector: null,
  currentAltFt: null,
  phraseology: null,
  probe: null,
  facts: null,
  review: null,
  reviewBy: null,
  pointOut: null,
  steps: [],
  final: null,
  progressToken: null,
  ...over,
});

describe("alternativeOf", () => {
  test("none without a probe alternative or callsign", () => {
    expect(alternativeOf(base())).toBeUndefined();
    expect(alternativeOf(base({ callsign: "SWA2140", probe: { ok: false, reasons: [], conflicts: [] } }))).toBeUndefined();
    expect(alternativeOf(base({ probe: { ok: false, reasons: [], conflicts: [], alternative: { kind: "altitude", value: 5000 } } }))).toBeUndefined();
  });

  test("altitude alternative in standard phraseology", () => {
    const f = base({ callsign: "SWA2140", currentAltFt: 7800, probe: { ok: false, reasons: ["x"], conflicts: [], alternative: { kind: "altitude", value: 5000 } } });
    expect(alternativeOf(f)).toEqual({
      callsign: "SWA2140",
      kind: "altitude",
      value: 5000,
      text: "Southwest twenty-one forty, descend and maintain five thousand.",
    });
  });

  test("heading alternative keeps the turn direction", () => {
    const f = base({ callsign: "UAL123", probe: { ok: false, reasons: [], conflicts: [], alternative: { kind: "heading", value: 250, turn: "left" } } });
    const a = alternativeOf(f)!;
    expect(a.turn).toBe("left");
    expect(a.text).toBe("United one twenty-three, turn left heading two five zero.");
  });
});

describe("log and finish", () => {
  test("log appends a step without mutating the input", () => {
    const f = base();
    const g = log(f, "parse", "ok", "SWA2140 altitude 4000", Date.now());
    expect(f.steps).toHaveLength(0);
    expect(g.steps).toHaveLength(1);
    expect(g.steps[0]).toMatchObject({ id: "parse", status: "ok", detail: "SWA2140 altitude 4000" });
    expect(g.steps[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  test("finish builds a schema-valid final result from the flow", () => {
    const f = log(
      base({
        parsed: { callsign: "SWA2140", kind: "altitude", value: 4000 },
        hex: "a1b2c3",
        callsign: "SWA2140",
        sector: "SOUTH",
        phraseology: "Southwest twenty-one forty, descend and maintain four thousand.",
        probe: { ok: true, reasons: [], conflicts: [] },
      }),
      "probe",
      "ok",
      "No conflicts. Valid.",
      Date.now(),
    );
    const done = finish(f, { issued: true });
    expect(done.final).not.toBeNull();
    const r = ClearanceResultSchema.parse(done.final);
    expect(r).toMatchObject({ issued: true, transcript: f.text, hex: "a1b2c3", sector: "SOUTH", phraseology: f.phraseology! });
    expect(r.steps).toHaveLength(1);
    expect(r.override).toBeUndefined();
  });

  test("finish omits empty fields and lets extra override", () => {
    const done = finish(base({ override: true }), { issued: false, reason: "No active airport.", sayAgain: true });
    expect(done.final).toEqual({
      transcript: base().text,
      override: true,
      steps: [],
      issued: false,
      reason: "No active airport.",
      sayAgain: true,
    });
  });
});
