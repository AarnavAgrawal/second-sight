// Loads data/airports-us.json once and resolves user input to an Airport (with magnetic declination).
import { lookupAirport, type AirportRow } from "../../shared/airports.ts";
import { declinationDeg } from "../../shared/magvar.ts";
import type { Airport } from "../../shared/types.ts";
import { config, repoPath } from "./config.ts";

let rows: AirportRow[] | null = null;

async function loadRows(): Promise<AirportRow[]> {
  if (!rows) rows = (await Bun.file(repoPath("data/airports-us.json")).json()) as AirportRow[];
  return rows;
}

export type ResolveResult = { airport: Airport } | { error: string; suggestions: { icao: string; name: string; city: string }[] };

export async function resolveAirport(code: string): Promise<ResolveResult> {
  const r = lookupAirport(await loadRows(), code, config.radiusNm);
  if ("error" in r) return r;
  const a = r.airport;
  return { airport: { ...a, declinationDeg: Math.round(declinationDeg(a.lat, a.lon) * 10) / 10 } };
}
