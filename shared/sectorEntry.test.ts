import { describe, expect, test } from "bun:test";
import { sectorEntry } from "./sectorEntry.ts";
import { SFO, pos } from "./test-utils.ts";

const southOfLine = (nm: number, over = {}) => pos({ lat: SFO.lat - nm / 60, lon: SFO.lon, ...over });

describe("sectorEntry", () => {
  test("straight projection across the line enters the other sector", () => {
    // 2 NM south, northbound at 240 kt (4 NM/min): reaches the line at about 30 s.
    const ac = southOfLine(2, { trackTrueDeg: 0, gsKt: 240 });
    const e = sectorEntry(ac, null, SFO, "SOUTH");
    expect(e.entersOther).toBe(true);
    expect(e.sector).toBe("NORTH");
    expect(e.inSec).toBeGreaterThanOrEqual(30);
    expect(e.inSec).toBeLessThanOrEqual(40);
  });

  test("moving away from the line stays in the sector", () => {
    const ac = southOfLine(2, { trackTrueDeg: 180, gsKt: 240 });
    expect(sectorEntry(ac, null, SFO, "SOUTH")).toEqual({ entersOther: false });
  });

  test("altitude clearance keeps the straight lateral path", () => {
    const ac = southOfLine(2, { trackTrueDeg: 0, gsKt: 240 });
    const e = sectorEntry(ac, { kind: "altitude", value: 10000 }, SFO, "SOUTH");
    expect(e.entersOther).toBe(true);
    expect(e.sector).toBe("NORTH");
  });

  test("heading clearance that turns away avoids the crossing", () => {
    // 3 NM south, northbound at 120 kt: straight, it crosses at about 90 s.
    const ac = southOfLine(3, { trackTrueDeg: 0, gsKt: 120 });
    expect(sectorEntry(ac, null, SFO, "SOUTH").entersOther).toBe(true);
    const e = sectorEntry(ac, { kind: "heading", value: 90, turn: "right" }, SFO, "SOUTH");
    expect(e.entersOther).toBe(false);
  });

  test("NORTH owner, southbound aircraft enters SOUTH", () => {
    const ac = pos({ lat: SFO.lat + 1 / 60, lon: SFO.lon, trackTrueDeg: 180, gsKt: 240 });
    const e = sectorEntry(ac, null, SFO, "NORTH");
    expect(e.entersOther).toBe(true);
    expect(e.sector).toBe("SOUTH");
  });
});
