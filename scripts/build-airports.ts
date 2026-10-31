// Build data/airports-us.json from the OurAirports data/airports.csv download.
// Usage: bun scripts/build-airports.ts
import type { AirportRow } from "../shared/airports.ts";

const root = new URL("..", import.meta.url);
const csvPath = new URL("data/airports.csv", root);
const outPath = new URL("data/airports-us.json", root);

/** RFC 4180-style CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const KEEP_TYPES = new Set(["large_airport", "medium_airport", "small_airport"]);
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

const rows = parseCsv(await Bun.file(csvPath).text());
const header = rows[0]!;
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`airports.csv: missing column ${name}`);
  return i;
};
const C = {
  ident: col("ident"),
  type: col("type"),
  name: col("name"),
  lat: col("latitude_deg"),
  lon: col("longitude_deg"),
  elev: col("elevation_ft"),
  country: col("iso_country"),
  region: col("iso_region"),
  city: col("municipality"),
  gps: col("gps_code"),
  iata: col("iata_code"),
  local: col("local_code"),
};

const out: AirportRow[] = [];
for (const r of rows.slice(1)) {
  if (r.length < header.length) continue;
  if (r[C.country] !== "US" || !KEEP_TYPES.has(r[C.type]!)) continue;
  const lat = Number(r[C.lat]);
  const lon = Number(r[C.lon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const elev = Number(r[C.elev]);
  out.push({
    ident: r[C.ident]!,
    type: r[C.type]!,
    name: r[C.name]!,
    lat: round5(lat),
    lon: round5(lon),
    elevationFt: r[C.elev] && Number.isFinite(elev) ? elev : 0,
    city: r[C.city] ?? "",
    state: (r[C.region] ?? "").split("-")[1] ?? "",
    gps: r[C.gps] ?? "",
    iata: r[C.iata] ?? "",
    local: r[C.local] ?? "",
  });
}

const json = JSON.stringify(out);
await Bun.write(outPath, json);
const by = (t: string) => out.filter((a) => a.type === t).length;
console.log(
  `Wrote ${out.length} US airports (${by("large_airport")} large, ${by("medium_airport")} medium, ` +
    `${by("small_airport")} small), ${(json.length / 1024 / 1024).toFixed(2)} MB`,
);
for (const id of ["KSFO", "KJFK", "PHNL"]) {
  const a = out.find((x) => x.ident === id);
  console.log(id, a ? `${a.name}, ${a.city} ${a.state}, elev ${a.elevationFt}` : "MISSING");
}
