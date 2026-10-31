import { describe, expect, test } from "bun:test";
import { destination } from "../../shared/geo.ts";
import { SFO } from "../../shared/test-utils.ts";
import { applyScenario, type Scenario, type ScenarioInject } from "./scenario.ts";

const inject = (over: Partial<ScenarioInject> = {}): ScenarioInject => ({
  hex: "5e0001",
  callsign: "SIM101",
  startSec: 10,
  endSec: 70,
  lat: 37.8,
  lon: -122.4,
  altFt: 6000,
  gsKt: 360,
  trackTrueDeg: 180,
  ...over,
});
const recorded = [{ hex: "a1b2c3", flight: "UAL123  ", alt_baro: 8000, baro_rate: 0, lat: 37.7, lon: -122.3, squawk: "4521" }];
const sim = (out: Record<string, unknown>[]) => out.find((a) => a.hex === "5e0001");
/** Reset the module's per-loop bend state (applyScenario clears it whenever tSec < 1). */
const resetLoop = (s: Scenario) => applyScenario(s, recorded, 0, SFO);

describe("applyScenario: inject", () => {
  const s: Scenario = { inject: [inject()] };

  test("appears only within [startSec, endSec]", () => {
    expect(sim(applyScenario(s, recorded, 9.9, SFO))).toBeUndefined();
    expect(sim(applyScenario(s, recorded, 10, SFO))).toBeDefined();
    expect(sim(applyScenario(s, recorded, 70, SFO))).toBeDefined();
    expect(sim(applyScenario(s, recorded, 70.1, SFO))).toBeUndefined();
  });

  test("keeps recorded traffic and does not mutate it", () => {
    const out = applyScenario(s, recorded, 20, SFO);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(recorded[0]!);
    expect(recorded).toHaveLength(1);
  });

  test("no endSec: stays for the rest of the loop", () => {
    expect(sim(applyScenario({ inject: [inject({ endSec: undefined })] }, recorded, 5000, SFO))).toBeDefined();
  });

  test("dead-reckons position from ground speed and track", () => {
    const a = sim(applyScenario(s, recorded, 40, SFO))!; // 30 s at 360 kt = 3 NM south
    const want = destination(37.8, -122.4, 180, 3);
    expect(a.lat as number).toBeCloseTo(want.lat, 6);
    expect(a.lon as number).toBeCloseTo(want.lon, 6);
    expect(a.track).toBe(180);
    expect(a.gs).toBe(360);
  });

  test("readsb-shaped fields: padded flight, default type, seen 0", () => {
    const a = sim(applyScenario(s, recorded, 10, SFO))!;
    expect(a.flight).toBe("SIM101  ");
    expect(a.t).toBe("B738");
    expect(a.seen).toBe(0);
    expect(a.alt_baro).toBe(6000);
  });

  test("squawk defaults to 4 + last 3 hex digits, override wins", () => {
    expect(sim(applyScenario(s, recorded, 10, SFO))!.squawk).toBe("4001");
    expect(sim(applyScenario({ inject: [inject({ squawk: "5123" })] }, recorded, 10, SFO))!.squawk).toBe("5123");
  });

  test("climbs at the given rate and levels off", () => {
    const c: Scenario = { inject: [inject({ vertRateFpm: 1200, levelOffFt: 7000 })] };
    const mid = sim(applyScenario(c, recorded, 40, SFO))!; // 30 s at 1,200 fpm = +600 ft
    expect(mid.alt_baro).toBe(6600);
    expect(mid.baro_rate).toBe(1200);
    const lvl = sim(applyScenario(c, recorded, 70, SFO))!; // 60 s would be +1,200 ft: capped at 7,000
    expect(lvl.alt_baro).toBe(7000);
    expect(lvl.baro_rate).toBe(0);
  });

  test("descends and levels off", () => {
    const d: Scenario = { inject: [inject({ vertRateFpm: -2000, levelOffFt: 5000 })] };
    expect(sim(applyScenario(d, recorded, 70, SFO))!.alt_baro).toBe(5000);
  });
});

describe("applyScenario: bend", () => {
  const ual = (out: Record<string, unknown>[]) => out.find((a) => a.hex === "a1b2c3")!;

  test("outside the window the recorded aircraft is untouched", () => {
    const s: Scenario = { bend: [{ callsign: "UAL123", fromSec: 20, toSec: 50, vertRateFpm: 1500 }] };
    resetLoop(s);
    expect(ual(applyScenario(s, recorded, 10, SFO))).toBe(recorded[0]!);
    expect(ual(applyScenario(s, recorded, 51, SFO))).toBe(recorded[0]!);
  });

  test("bends altitude from the recorded altitude at fromSec, with level-off", () => {
    const s: Scenario = { bend: [{ callsign: "UAL123", fromSec: 20, vertRateFpm: 1500, levelOffFt: 9000 }] };
    resetLoop(s);
    expect(ual(applyScenario(s, recorded, 20, SFO)).alt_baro).toBe(8000);
    const mid = ual(applyScenario(s, recorded, 30, SFO)); // 10 s at 1,500 fpm = +250 ft
    expect(mid.alt_baro).toBe(8250);
    expect(mid.baro_rate).toBe(1500);
    const lvl = ual(applyScenario(s, recorded, 80, SFO));
    expect(lvl.alt_baro).toBe(9000);
    expect(lvl.baro_rate).toBe(0);
  });

  test("explicit altFt overrides the recorded altitude", () => {
    const s: Scenario = { bend: [{ callsign: "UAL123", fromSec: 20, altFt: 4000, vertRateFpm: -600 }] };
    resetLoop(s);
    expect(ual(applyScenario(s, recorded, 30, SFO)).alt_baro).toBe(3900);
  });

  test("other aircraft are not bent", () => {
    const s: Scenario = { bend: [{ callsign: "DAL456", fromSec: 0, vertRateFpm: 3000 }] };
    resetLoop(s);
    expect(ual(applyScenario(s, recorded, 30, SFO))).toBe(recorded[0]!);
  });
});
