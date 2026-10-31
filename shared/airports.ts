// Airport lookup over data/airports-us.json rows (CLAUDE.md section 9). Pure: rows are passed in.
import type { Airport } from "./types.ts";

export interface AirportRow {
  ident: string;
  /** "large_airport" | "medium_airport" | "small_airport" */
  type: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt: number;
  city: string;
  /** Two-letter state from iso_region ("US-CA" -> "CA"). */
  state: string;
  gps: string;
  iata: string;
  local: string;
}

export interface AirportSuggestion {
  icao: string;
  name: string;
  city: string;
}

export type LookupResult =
  | { airport: Omit<Airport, "declinationDeg"> }
  | { error: string; suggestions: AirportSuggestion[] };

const TYPE_RANK: Record<string, number> = { large_airport: 0, medium_airport: 1, small_airport: 2 };
const rank = (r: AirportRow) => TYPE_RANK[r.type] ?? 3;

interface Index {
  ident: Map<string, AirportRow>;
  gps: Map<string, AirportRow>;
  iata: Map<string, AirportRow>;
  local: Map<string, AirportRow>;
  sorted: AirportRow[];
}

const cache = new WeakMap<AirportRow[], Index>();

function put(map: Map<string, AirportRow>, key: string, row: AirportRow) {
  if (!key) return;
  const k = key.toUpperCase();
  const prev = map.get(k);
  if (!prev || rank(row) < rank(prev)) map.set(k, row);
}

function indexOf(rows: AirportRow[]): Index {
  let idx = cache.get(rows);
  if (idx) return idx;
  idx = { ident: new Map(), gps: new Map(), iata: new Map(), local: new Map(), sorted: [] };
  for (const r of rows) {
    put(idx.ident, r.ident, r);
    put(idx.gps, r.gps, r);
    put(idx.iata, r.iata, r);
    put(idx.local, r.local, r);
  }
  idx.sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.ident.localeCompare(b.ident));
  cache.set(rows, idx);
  return idx;
}

function toAirport(row: AirportRow, icao: string, radiusNm: number): Omit<Airport, "declinationDeg"> {
  return {
    icao: icao.toUpperCase(),
    name: row.name,
    city: row.city,
    state: row.state,
    lat: row.lat,
    lon: row.lon,
    elevationFt: Number.isFinite(row.elevationFt) ? row.elevationFt : 0,
    radiusNm,
  };
}

const displayCode = (r: AirportRow) => (r.gps || r.ident).toUpperCase();

/**
 * Resolve user input to an airport. Match on ident, then gps code. A 3-letter code tries "K"+code,
 * then IATA, then local code. Otherwise return up to 5 suggestions by prefix (large airports first).
 */
export function lookupAirport(rows: AirportRow[], input: string, radiusNm: number): LookupResult {
  const code = (input ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!code) return { error: "Enter a US airport code.", suggestions: [] };
  const idx = indexOf(rows);

  const byIdent = idx.ident.get(code);
  if (byIdent) return { airport: toAirport(byIdent, byIdent.ident, radiusNm) };
  const byGps = idx.gps.get(code);
  if (byGps) return { airport: toAirport(byGps, byGps.gps, radiusNm) };
  if (code.length === 3) {
    const k = idx.ident.get("K" + code);
    if (k) return { airport: toAirport(k, k.ident, radiusNm) };
    const iata = idx.iata.get(code) ?? idx.local.get(code);
    if (iata) return { airport: toAirport(iata, iata.ident, radiusNm) };
  }

  const prefixes = code.length <= 3 && !code.startsWith("K") ? [code, "K" + code] : [code];
  const suggestions: AirportSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of idx.sorted) {
    if (suggestions.length >= 5) break;
    const keys = [r.ident, r.gps, r.iata].map((s) => (s ?? "").toUpperCase());
    if (!keys.some((k) => k && prefixes.some((p) => k.startsWith(p)))) continue;
    const c = displayCode(r);
    if (seen.has(c)) continue;
    seen.add(c);
    suggestions.push({ icao: c, name: r.name, city: r.city });
  }
  return { error: `No US airport matches "${code}".`, suggestions };
}
