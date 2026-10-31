import { describe, expect, test } from "bun:test";
import { consistentWithSpoken, matchCallsign, readNumber, tokens } from "./callsignMatch.ts";

const RADAR = ["SWA3686", "UAL271", "AAL271", "DAL668", "UAL562", "ASA1413", "N234KB", "FDX1468", "UAL984", "SKW5899"];

describe("readNumber", () => {
  const num = (s: string) => readNumber(tokens(s), 0)?.digits;
  test("group forms", () => {
    expect(num("thirty-six eighty-six")).toBe("3686");
    expect(num("twenty-seven zero three heavy")).toBe("2703");
    expect(num("three seventy-three")).toBe("373");
    expect(num("fourteen sixty-eight")).toBe("1468");
    expect(num("nine eighty-four")).toBe("984");
    expect(num("271, turn left")).toBe("271");
  });
});

describe("matchCallsign", () => {
  test("airline + group-form flight number", () => {
    expect(matchCallsign("Southwest thirty six eighty six turn left heading three one zero", RADAR)).toEqual({ callsign: "SWA3686", method: "airline" });
    expect(matchCallsign("South west thirty-six eighty-six, maintain one zero thousand", RADAR)?.callsign).toBe("SWA3686");
    expect(matchCallsign("FedEx fourteen sixty-eight, cleared visual approach", RADAR)?.callsign).toBe("FDX1468");
  });
  test("airline disambiguates a shared flight number", () => {
    expect(matchCallsign("American 271, descend and maintain six thousand", RADAR)?.callsign).toBe("AAL271");
    expect(matchCallsign("United two seventy one, maintain one zero thousand", RADAR)?.callsign).toBe("UAL271");
  });
  test("one digit off with the right airline, only when unique", () => {
    expect(matchCallsign("Alaska fourteen one four, descend and maintain eight thousand", RADAR)).toEqual({ callsign: "ASA1413", method: "airline_fuzzy" });
  });
  test("abbreviated callsign at the start of a controller transmission", () => {
    expect(matchCallsign("six six eight turn right heading zero one zero, maintain six thousand", RADAR, "start")).toEqual({ callsign: "DAL668", method: "number" });
    expect(matchCallsign("Five sixty-two, descend and maintain four thousand", RADAR, "start")?.callsign).toBe("UAL562");
  });
  test("ambiguous bare number does not match", () => {
    expect(matchCallsign("two seventy one, maintain one zero thousand", RADAR, "start")).toBeNull();
  });
  test("readback with the callsign last", () => {
    expect(matchCallsign("left three one zero, maintain one zero thousand, nine eighty-four heavy", RADAR, "end")?.callsign).toBe("UAL984");
  });
  test("N-number by phonetic suffix", () => {
    expect(matchCallsign("Four Kilo Bravo, fly heading one zero zero", RADAR)).toEqual({ callsign: "N234KB", method: "n_number" });
  });
  test("a spoken airline never matches a different airline's flight number", () => {
    expect(matchCallsign("Southwest six six eight", RADAR, "end")).toBeNull();
    expect(matchCallsign("cleared visual, JetBlue nine eighty-four", RADAR, "end")).toBeNull();
  });
  test("runway numbers are not fuzzy-matched", () => {
    expect(matchCallsign("United two eight left", ["UAL29", "UAL271"])).toBeNull();
  });
  test("clearance numbers alone never match", () => {
    expect(matchCallsign("Turn left heading three one zero, maintain six thousand", RADAR, "start")).toBeNull();
    expect(matchCallsign("Maintain four thousand.", RADAR)).toBeNull();
  });
});

describe("consistentWithSpoken", () => {
  test("rejects a callsign whose flight number was not what was said", () => {
    expect(consistentWithSpoken("Alaska thirty-nine seven, right turn one nine zero", "ASA235")).toBe(false);
    expect(consistentWithSpoken("SkyWest 379 descend and maintain 8000", "SKW4733")).toBe(false);
  });
  test("accepts exact, one digit off, and a mis-heard airline with the exact number", () => {
    expect(consistentWithSpoken("SkyWest 5889, reduce speed 190", "SKW5899")).toBe(true);
    expect(consistentWithSpoken("Delta three seventy-three heavy, descend and maintain six thousand", "KLM373")).toBe(true);
  });
  test("nothing to check when no airline and number were spoken", () => {
    expect(consistentWithSpoken("descend and maintain three thousand", "UAL1")).toBeNull();
  });
});
