import { describe, expect, test } from "bun:test";
import { airlinePrefix, callsignVariants, digitsGroupWords, spokenCallsign, telephonyOf } from "./telephony.ts";

describe("digitsGroupWords", () => {
  const cases: [string, string][] = [
    ["5", "five"],
    ["12", "twelve"],
    ["123", "one twenty-three"],
    ["456", "four fifty-six"],
    ["811", "eight eleven"],
    ["105", "one zero five"],
    ["100", "one hundred"],
    ["2140", "twenty-one forty"],
    ["2100", "twenty-one hundred"],
    ["2005", "twenty zero five"],
    ["1000", "one thousand"],
    ["1234", "twelve thirty-four"],
    ["40", "forty"],
  ];
  for (const [n, w] of cases) test(`${n} -> ${w}`, () => expect(digitsGroupWords(n)).toBe(w));
});

describe("spokenCallsign", () => {
  test("air carriers", () => {
    expect(spokenCallsign("UAL123")).toBe("United one twenty-three");
    expect(spokenCallsign("SWA2140")).toBe("Southwest twenty-one forty");
    expect(spokenCallsign("JBU811")).toBe("JetBlue eight eleven");
    expect(spokenCallsign("DAL456")).toBe("Delta four fifty-six");
    expect(spokenCallsign("BAW287")).toBe("Speedbird two eighty-seven");
    expect(spokenCallsign(" ual123 ")).toBe("United one twenty-three");
  });
  test("trailing letters spoken phonetically", () => {
    expect(spokenCallsign("UAL12K")).toBe("United twelve kilo");
  });
  test("N-numbers", () => {
    expect(spokenCallsign("N335RV")).toBe("November three three five romeo victor");
    expect(spokenCallsign("N345AB")).toBe("November three four five alpha bravo");
  });
  test("unknown prefix spelled out", () => {
    expect(spokenCallsign("XYZ123")).toBe("X-ray yankee zulu one two three");
  });
});

describe("prefix and variants", () => {
  test("airlinePrefix / telephonyOf", () => {
    expect(airlinePrefix("DAL456")).toBe("DAL");
    expect(airlinePrefix("N335RV")).toBeNull();
    expect(telephonyOf("DAL456")).toBe("Delta");
    expect(telephonyOf("XYZ1")).toBeNull();
  });
  test("callsignVariants includes group and individual-digit forms", () => {
    const v = callsignVariants("UAL123");
    expect(v[0]).toBe("United one twenty-three");
    expect(v).toContain("United one two three");
  });
});
