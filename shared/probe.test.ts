import { describe, expect, test } from "bun:test";
import { probeClearance, projectClearedPath, simplifiedFloorFt, validateClearance } from "./probe.ts";
import { bearingDeg } from "./geo.ts";
import { SFO, offset, pos } from "./test-utils.ts";

describe("simplifiedFloorFt", () => {
  test("field elevation + 1,500 rounded up to 100", () => {
    expect(simplifiedFloorFt({ elevationFt: 13 })).toBe(1600);
    expect(simplifiedFloorFt({ elevationFt: 5431 })).toBe(7000);
    expect(simplifiedFloorFt({ elevationFt: 0 })).toBe(1500);
  });
});

describe("validateClearance", () => {
  test("headings 001..360 integers", () => {
    expect(validateClearance({ kind: "heading", value: 270 }, SFO)).toEqual([]);
    expect(validateClearance({ kind: "heading", value: 360 }, SFO)).toEqual([]);
    expect(validateClearance({ kind: "heading", value: 0 }, SFO)).toHaveLength(1);
    expect(validateClearance({ kind: "heading", value: 361 }, SFO)).toHaveLength(1);
    expect(validateClearance({ kind: "heading", value: 270.5 }, SFO)).toHaveLength(1);
  });
  test("altitudes: 100 ft steps, floor, FL450", () => {
    expect(validateClearance({ kind: "altitude", value: 8000 }, SFO)).toEqual([]);
    expect(validateClearance({ kind: "altitude", value: 7850 }, SFO)).toEqual(["Altitude must be in 100 ft steps."]);
    expect(validateClearance({ kind: "altitude", value: 46000 }, SFO)).toEqual(["Above FL450."]);
    expect(validateClearance({ kind: "altitude", value: 1000 }, SFO)).toEqual([
      "Below simplified minimum altitude floor.",
    ]);
  });
});

describe("projectClearedPath", () => {
  test("altitude: climbs at 1,500 fpm minimum then levels", () => {
    const p = pos({ altFt: 6000, vertRateFpm: 0 });
    const path = projectClearedPath(p, { kind: "altitude", value: 8000 }, 0);
    expect(path).toHaveLength(13);
    expect(path[0]!.altFt).toBe(6000);
    expect(path[4]!.altFt).toBe(7000); // 40 s at 1,500 fpm
    expect(path[12]!.altFt).toBe(8000); // levels at target
  });
  test("altitude: uses current rate when faster", () => {
    const p = pos({ altFt: 10000, vertRateFpm: -3000 });
    const path = projectClearedPath(p, { kind: "altitude", value: 4000 }, 0);
    expect(path[6]!.altFt).toBe(7000);
    expect(path[12]!.altFt).toBe(4000);
  });
  test("heading: magnetic converted to true with declination, then straight", () => {
    const p = pos({ trackTrueDeg: 90, gsKt: 300 });
    const path = projectClearedPath(p, { kind: "heading", value: 90 }, 13); // true 103
    const a = path[11]!;
    const b = path[12]!;
    expect(bearingDeg(a.lat, a.lon, b.lat, b.lon)).toBeCloseTo(103, 0);
  });
  test("heading: turn direction honored (left the long way)", () => {
    const p = pos({ trackTrueDeg: 90, gsKt: 300 });
    // Left turn from 090 to 120 is 330 degrees: after 120 s (360 deg possible) it has finished.
    const left = projectClearedPath(p, { kind: "heading", value: 120, turn: "left" }, 0);
    // After 10 s of a left turn it should be north of the start (heading through 060..030).
    expect(left[1]!.lat).toBeGreaterThan(p.lat);
    const right = projectClearedPath(p, { kind: "heading", value: 120, turn: "right" }, 0);
    expect(right[1]!.lat).toBeLessThan(p.lat);
  });
});

describe("probeClearance", () => {
  const ac = pos({ hex: "aaa", callsign: "UAL123", altFt: 6000, vertRateFpm: 0, trackTrueDeg: 90, gsKt: 250 });
  // Traffic 1 NM north, same track and speed, level at 8,000.
  const traffic = offset(ac, 0, 1, { hex: "bbb", callsign: "DAL456", altFt: 8000, trackTrueDeg: 90, gsKt: 250 });

  test("clear airspace passes", () => {
    const r = probeClearance(ac, { kind: "altitude", value: 8000 }, [ac], SFO);
    expect(r).toEqual({ ok: true, reasons: [], conflicts: [] });
  });

  test("altitude into traffic's level fails with an alternative 1,000 ft short", () => {
    const r = probeClearance(ac, { kind: "altitude", value: 8000 }, [ac, traffic], SFO);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.with).toBe("DAL456");
    expect(r.conflicts[0]!.inSec).toBe(50); // 1,500 fpm from 6,000: above 7,000 after 40 s
    expect(r.reasons[0]).toMatch(/^Traffic DAL456, 1\.0 NM, 0 ft, in 50 s\.$/);
    expect(r.alternative).toEqual({ kind: "altitude", value: 7000 });
  });

  test("below the simplified floor", () => {
    const r = probeClearance(ac, { kind: "altitude", value: 1000 }, [ac], SFO);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain("Below simplified minimum altitude floor.");
    expect(r.alternative).toEqual({ kind: "altitude", value: 2000 });
  });

  test("heading into traffic fails; alternative +/-20 then +/-40", () => {
    // Aircraft tracking true 013 (= magnetic 360 with 13E declination), 240 kt.
    const me = pos({ hex: "aaa", callsign: "SWA2140", altFt: 8000, trackTrueDeg: 13, gsKt: 240 });
    // Stationary traffic 6 NM ahead on true 013, same altitude.
    const t = offset(me, 13, 6, { hex: "ccc", callsign: "N335RV", altFt: 8000, gsKt: 0 });
    const r = probeClearance(me, { kind: "heading", value: 360 }, [me, t], SFO);
    expect(r.ok).toBe(false);
    expect(r.conflicts[0]!.with).toBe("N335RV");
    // +/-20 passes within 2.05 NM; +40 clears by 3.9 NM.
    expect(r.alternative).toEqual({ kind: "heading", value: 40 });
  });

  test("heading away from traffic passes", () => {
    const me = pos({ hex: "aaa", callsign: "SWA2140", altFt: 8000, trackTrueDeg: 13, gsKt: 240 });
    const t = offset(me, 13, 6, { hex: "ccc", callsign: "N335RV", altFt: 8000, gsKt: 0 });
    const r = probeClearance(me, { kind: "heading", value: 180, turn: "right" }, [me, t], SFO);
    expect(r.ok).toBe(true);
    expect(r.alternative).toBeUndefined();
  });

  test("invalid heading is reported without probing", () => {
    const r = probeClearance(ac, { kind: "heading", value: 400 }, [ac], SFO);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(["Heading must be 001 to 360."]);
  });
});
