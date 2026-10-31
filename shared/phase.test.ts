import { describe, expect, test } from "bun:test";
import { flightPhase } from "./phase.ts";
import { SFO, pos } from "./test-utils.ts";

const north = (nm: number, over = {}) => pos({ lat: SFO.lat + nm / 60, lon: SFO.lon, ...over });

describe("flightPhase (estimated phase)", () => {
  test("departure: close in, climbing, moving away", () => {
    expect(flightPhase(north(5, { trackTrueDeg: 0, vertRateFpm: 2000, altFt: 4000 }), SFO)).toBe("departure");
  });

  test("arrival: within 40 NM, descending, moving toward the airport", () => {
    expect(flightPhase(north(20, { trackTrueDeg: 180, vertRateFpm: -1000, altFt: 7000 }), SFO)).toBe("arrival");
  });

  test("overflight: level", () => {
    expect(flightPhase(north(10, { trackTrueDeg: 90, vertRateFpm: 0 }), SFO)).toBe("overflight");
  });

  test("climbing toward the airport is not a departure", () => {
    expect(flightPhase(north(5, { trackTrueDeg: 180, vertRateFpm: 2000 }), SFO)).toBe("overflight");
  });

  test("climbing away beyond 25 NM is not a departure", () => {
    expect(flightPhase(north(30, { trackTrueDeg: 0, vertRateFpm: 2000 }), SFO)).toBe("overflight");
  });

  test("descending away from the airport is not an arrival", () => {
    expect(flightPhase(north(20, { trackTrueDeg: 0, vertRateFpm: -1000 }), SFO)).toBe("overflight");
  });

  test("descending beyond 40 NM is not an arrival", () => {
    expect(flightPhase(north(45, { trackTrueDeg: 180, vertRateFpm: -1000 }), SFO)).toBe("overflight");
  });

  test("thresholds are inclusive at 500 fpm", () => {
    expect(flightPhase(north(5, { trackTrueDeg: 0, vertRateFpm: 500 }), SFO)).toBe("departure");
    expect(flightPhase(north(20, { trackTrueDeg: 180, vertRateFpm: -500 }), SFO)).toBe("arrival");
    expect(flightPhase(north(5, { trackTrueDeg: 0, vertRateFpm: 499 }), SFO)).toBe("overflight");
  });
});
