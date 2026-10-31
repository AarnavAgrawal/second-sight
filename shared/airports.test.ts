import { describe, expect, test } from "bun:test";
import { lookupAirport, type AirportRow } from "./airports.ts";

const row = (o: Partial<AirportRow>): AirportRow => ({
  ident: "",
  type: "small_airport",
  name: "",
  lat: 0,
  lon: 0,
  elevationFt: 0,
  city: "",
  state: "",
  gps: "",
  iata: "",
  local: "",
  ...o,
});

const ROWS: AirportRow[] = [
  row({ ident: "KSFO", type: "large_airport", name: "San Francisco International Airport", lat: 37.619, lon: -122.375, elevationFt: 13, city: "San Francisco", state: "CA", gps: "KSFO", iata: "SFO", local: "SFO" }),
  row({ ident: "KSFF", type: "small_airport", name: "Felts Field", city: "Spokane", state: "WA", gps: "KSFF", iata: "SFF", local: "SFF" }),
  row({ ident: "KSMF", type: "large_airport", name: "Sacramento International Airport", city: "Sacramento", state: "CA", gps: "KSMF", iata: "SMF", local: "SMF" }),
  row({ ident: "KJFK", type: "large_airport", name: "John F. Kennedy International Airport", lat: 40.64, lon: -73.78, elevationFt: 13, city: "New York", state: "NY", gps: "KJFK", iata: "JFK", local: "JFK" }),
  row({ ident: "PHNL", type: "large_airport", name: "Daniel K. Inouye International Airport", city: "Honolulu", state: "HI", gps: "PHNL", iata: "HNL", local: "HNL" }),
  row({ ident: "US-0042", type: "small_airport", name: "Gps Only Field", city: "Nowhere", state: "TX", gps: "K0Z9", local: "0Z9" }),
  row({ ident: "06C", type: "small_airport", name: "Schaumburg Regional Airport", city: "Chicago/Schaumburg", state: "IL", gps: "K06C", local: "06C", elevationFt: NaN }),
];

describe("lookupAirport", () => {
  test("exact ident, normalized", () => {
    const r = lookupAirport(ROWS, " ksfo ", 35);
    expect(r).toEqual({
      airport: { icao: "KSFO", name: "San Francisco International Airport", city: "San Francisco", state: "CA", lat: 37.619, lon: -122.375, elevationFt: 13, radiusNm: 35 },
    });
  });
  test("gps code match uses the gps code as icao", () => {
    const r = lookupAirport(ROWS, "K0Z9", 35);
    expect("airport" in r && r.airport.icao).toBe("K0Z9");
  });
  test("3-letter: K + code, then IATA, then local", () => {
    const sfo = lookupAirport(ROWS, "sfo", 35);
    expect("airport" in sfo && sfo.airport.icao).toBe("KSFO");
    const hnl = lookupAirport(ROWS, "HNL", 35);
    expect("airport" in hnl && hnl.airport.icao).toBe("PHNL");
    const local = lookupAirport(ROWS, "0Z9", 35);
    expect("airport" in local && local.airport.name).toBe("Gps Only Field");
  });
  test("ident match beats gps; missing elevation becomes 0", () => {
    const r = lookupAirport(ROWS, "06C", 35);
    expect("airport" in r && r.airport.icao).toBe("06C");
    expect("airport" in r && r.airport.elevationFt).toBe(0);
  });
  test("no match: up to 5 suggestions by prefix, large airports first", () => {
    const r = lookupAirport(ROWS, "KS", 35);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.suggestions.map((s) => s.icao)).toEqual(["KSFO", "KSMF", "KSFF"]);
      expect(r.suggestions[0]).toEqual({ icao: "KSFO", name: "San Francisco International Airport", city: "San Francisco" });
    }
  });
  test("nothing close", () => {
    const r = lookupAirport(ROWS, "ZZZZ", 35);
    expect(r).toEqual({ error: 'No US airport matches "ZZZZ".', suggestions: [] });
    expect(lookupAirport(ROWS, "  ", 35)).toEqual({ error: "Enter a US airport code.", suggestions: [] });
  });
});
