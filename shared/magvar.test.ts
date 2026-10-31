import { describe, expect, test } from "bun:test";
import { declinationDeg } from "./magvar.ts";

describe("declinationDeg (WMM2025)", () => {
  const date = new Date("2026-10-31T12:00:00Z");
  test("KSFO is about 13 deg east", () => {
    const d = declinationDeg(37.619, -122.375, date);
    expect(d).toBeGreaterThan(12.4);
    expect(d).toBeLessThan(13.5);
  });
  test("KJFK is about 12.5 deg west", () => {
    const d = declinationDeg(40.6398, -73.7789, date);
    expect(d).toBeLessThan(-12);
    expect(d).toBeGreaterThan(-13.2);
  });
  test("out-of-model dates still return a value", () => {
    expect(Number.isFinite(declinationDeg(37.619, -122.375, new Date("2035-01-01")))).toBe(true);
  });
});
