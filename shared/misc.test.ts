// Tests for adsb, boundary, format.
import { describe, expect, test } from "bun:test";
import { normalizeAdsb } from "./adsb.ts";
import { boundaryApproach } from "./boundary.ts";
import { dataBlock } from "./format.ts";
import { destination } from "./geo.ts";
import { SFO, pos } from "./test-utils.ts";

describe("normalizeAdsb", () => {
  const NOW = 1_800_000_000_000;
  const raw = {
    now: NOW / 1000,
    ac: [
      { hex: "76CEF5", type: "adsb_icao", flight: "SIA12   ", r: "9V-SWU", t: "B77W", alt_baro: 35000, alt_geom: 35050, gs: 477.7, track: 132.71, baro_rate: 0, lat: 37.726547, lon: -122.791677, seen_pos: 0.393, seen: 0.2, squawk: "6257" },
      { hex: "a1", alt_baro: "ground", lat: 37.6, lon: -122.4, seen: 1 },
      { hex: "a2", r: "N335RV", squawk: "1200", alt_baro: 5000, geom_rate: -640, true_heading: 270, gs: 120, lat: 37.6, lon: -122.4, seen: 2 },
      { hex: "a3", alt_baro: 6000, lat: 37.6, lon: -122.4 },
      { hex: "a4", flight: "UAL1", alt_baro: 900, lat: 37.6, lon: -122.4, seen: 0 },
      { hex: "a5", flight: "UAL2", alt_baro: 9000, lat: 37.6, lon: -122.4, seen: 31 },
      { hex: "a6", flight: "UAL3", alt_baro: 9000, seen: 0 },
    ],
  };
  const out = normalizeAdsb(raw, SFO, NOW);

  test("keeps valid airborne aircraft only", () => {
    expect(out.map((p) => p.hex)).toEqual(["76cef5", "a2", "a3"]);
  });
  test("maps fields", () => {
    expect(out[0]).toEqual({
      hex: "76cef5",
      callsign: "SIA12",
      registration: "9V-SWU",
      typeCode: "B77W",
      lat: 37.726547,
      lon: -122.791677,
      altFt: 35000,
      gsKt: 477.7,
      trackTrueDeg: 132.71,
      vertRateFpm: 0,
      seenSec: 0.2,
      ts: NOW - 393,
      squawk: "6257",
      isVfr: false,
    });
  });
  test("squawk 1200 is VFR; no squawk is null and not VFR", () => {
    expect(out[1]!.squawk).toBe("1200");
    expect(out[1]!.isVfr).toBe(true);
    expect(out[2]!.squawk).toBeNull();
    expect(out[2]!.isVfr).toBe(false);
  });
  test("fallbacks: registration callsign, geom_rate, true_heading, hex callsign", () => {
    expect(out[1]!.callsign).toBe("N335RV");
    expect(out[1]!.vertRateFpm).toBe(-640);
    expect(out[1]!.trackTrueDeg).toBe(270);
    expect(out[2]!.callsign).toBe("A3");
    expect(out[2]!.gsKt).toBe(0);
  });
  test("garbage input", () => {
    expect(normalizeAdsb(null, SFO, NOW)).toEqual([]);
    expect(normalizeAdsb({ ac: "x" }, SFO, NOW)).toEqual([]);
  });
});

describe("boundaryApproach", () => {
  const north = (nm: number, track: number) => {
    const d = destination(SFO.lat, SFO.lon, 0, nm);
    return pos({ lat: d.lat, lon: d.lon, trackTrueDeg: track, gsKt: 300 });
  };
  test("2 NM north heading south crosses within 90 s", () => {
    expect(boundaryApproach(north(2, 180), SFO, "NORTH")).toEqual({ from: "NORTH", to: "SOUTH", distNm: 2 });
  });
  test("too far from the line", () => {
    expect(boundaryApproach(north(6, 180), SFO, "NORTH")).toBeNull();
  });
  test("heading away from the line", () => {
    expect(boundaryApproach(north(2, 0), SFO, "NORTH")).toBeNull();
  });
  test("owner already the other sector (handoff accepted early): no event", () => {
    expect(boundaryApproach(north(2, 180), SFO, "SOUTH")).toBeNull();
  });
});

describe("dataBlock", () => {
  test("STARS line 2", () => {
    expect(dataBlock(7800, 1800, 280)).toBe("078↑ 28");
    expect(dataBlock(35000, 0, 477.7)).toBe("350  48");
    expect(dataBlock(4000, -900, 95)).toBe("040↓ 10");
    expect(dataBlock(null, 0, 0)).toBe("---  00");
  });
});
