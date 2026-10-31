import { describe, expect, test } from "bun:test";
import {
  apreqPhrase,
  clearancePhrase,
  handoffPhrase,
  radarContactPhrase,
  spokenAltitude,
  spokenHeading,
  unablePhrase,
} from "./phraseology.ts";

describe("spokenAltitude / spokenHeading", () => {
  test("altitudes", () => {
    expect(spokenAltitude(10000)).toBe("one zero thousand");
    expect(spokenAltitude(8000)).toBe("eight thousand");
    expect(spokenAltitude(6500)).toBe("six thousand five hundred");
    expect(spokenAltitude(12500)).toBe("one two thousand five hundred");
    expect(spokenAltitude(7800)).toBe("seven thousand eight hundred");
    expect(spokenAltitude(24000)).toBe("flight level two four zero");
    expect(spokenAltitude(18000)).toBe("flight level one eight zero");
  });
  test("headings", () => {
    expect(spokenHeading(270)).toBe("two seven zero");
    expect(spokenHeading(360)).toBe("three six zero");
    expect(spokenHeading(0)).toBe("three six zero");
    expect(spokenHeading(45)).toBe("zero four five");
  });
});

describe("clearancePhrase", () => {
  test("climb / descend / maintain", () => {
    expect(clearancePhrase("UAL123", { kind: "altitude", value: 10000 }, 7800)).toBe(
      "United one twenty-three, climb and maintain one zero thousand.",
    );
    expect(clearancePhrase("SWA2140", { kind: "altitude", value: 4000 }, 7800)).toBe(
      "Southwest twenty-one forty, descend and maintain four thousand.",
    );
    expect(clearancePhrase("JBU811", { kind: "altitude", value: 24000 }, 31000)).toBe(
      "JetBlue eight eleven, descend and maintain flight level two four zero.",
    );
    expect(clearancePhrase("UAL123", { kind: "altitude", value: 8000 }, 8050)).toBe(
      "United one twenty-three, maintain eight thousand.",
    );
    expect(clearancePhrase("UAL123", { kind: "altitude", value: 8000 }, null)).toBe(
      "United one twenty-three, maintain eight thousand.",
    );
  });
  test("headings", () => {
    expect(clearancePhrase("DAL456", { kind: "heading", value: 270, turn: "left" }, null)).toBe(
      "Delta four fifty-six, turn left heading two seven zero.",
    );
    expect(clearancePhrase("DAL456", { kind: "heading", value: 90 }, null)).toBe(
      "Delta four fifty-six, fly heading zero nine zero.",
    );
  });
});

describe("controller-to-controller", () => {
  test("handoff", () => {
    expect(handoffPhrase("UAL123", 7800, 1800, 10000, 3, "north")).toBe(
      "Handoff, United one twenty-three, seven thousand eight hundred climbing to one zero thousand, three miles north of the line.",
    );
    expect(handoffPhrase("UAL123", 8000, 0, null, 2.4, "south")).toBe(
      "Handoff, United one twenty-three, eight thousand level, two miles south of the line.",
    );
    expect(handoffPhrase("UAL123", 8000, -900, null, 1, "south")).toBe(
      "Handoff, United one twenty-three, eight thousand descending, one mile south of the line.",
    );
  });
  test("radar contact", () => {
    expect(radarContactPhrase("UAL123")).toBe("United one twenty-three, radar contact.");
  });
  test("APREQ", () => {
    expect(apreqPhrase("DAL456", { kind: "heading", value: 270, turn: "left" }, "UAL123")).toBe(
      "APREQ, Delta four fifty-six, turn left heading two seven zero for traffic United one twenty-three.",
    );
    expect(apreqPhrase("DAL456", { kind: "altitude", value: 9000 }, "UAL123", 8000)).toBe(
      "APREQ, Delta four fifty-six, climb and maintain nine thousand for traffic United one twenty-three.",
    );
  });
  test("unable", () => {
    const s = unablePhrase(
      "UAL123",
      { kind: "altitude", value: 8000 },
      {
        ok: false,
        reasons: ["Traffic DAL456, 2.1 NM, 400 ft, in 40 s."],
        conflicts: [{ with: "DAL456", minLatNm: 2.1, minVertFt: 400, inSec: 40 }],
        alternative: { kind: "altitude", value: 7000 },
      },
    );
    expect(s).toBe(
      "Unable, United one twenty-three to eight thousand, traffic Delta four fifty-six, 2.1 miles, 400 feet, in 40 seconds. Suggest seven thousand.",
    );
  });
});
