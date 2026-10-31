// Standalone ADS-B recorder (no actors, no Relay): builds replay data for data/recordings/<ICAO>/.
//   bun scripts/record.ts KSFO 20      (airport, minutes; polls every 5 s)
// Same providers (adsb.lol, then adsb.fi), same kept fields and the same line format as
// bridge/src/source.ts LiveSource: {"ts": <epoch ms>, "ac": [...]} per line.
// Copied rather than imported: LiveSource writes its own file and uses a fixed 60 s cooldown; here a
// failed poll is retried inside its 5 s slot so the recording has no gaps.
import { appendFile, mkdir } from "node:fs/promises";
import { resolveAirport } from "../bridge/src/airports.ts";
import { config, repoPath } from "../bridge/src/config.ts";

const code = (process.argv[2] || "").trim().toUpperCase();
const minutes = Number(process.argv[3] || 20);
if (!code || !(minutes > 0)) {
  console.error("usage: bun scripts/record.ts <ICAO> <minutes>");
  process.exit(1);
}
const r = await resolveAirport(code);
if ("error" in r) {
  console.error(r.error, r.suggestions.map((s) => s.icao).join(" "));
  process.exit(1);
}
const airport = r.airport;

// Keep in sync with KEEP in bridge/src/source.ts.
const KEEP = ["hex", "flight", "r", "t", "lat", "lon", "alt_baro", "gs", "track", "true_heading", "baro_rate", "geom_rate", "seen", "seen_pos", "squawk"];
const trim = (a: Record<string, unknown>) => {
  const o: Record<string, unknown> = {};
  for (const k of KEEP) if (a[k] !== undefined) o[k] = a[k];
  return o;
};
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

const PROVIDERS = [
  { name: "adsb.lol", url: (lat: number, lon: number, nm: number) => `${config.adsbBase}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`, cooldownMs: 60_000 },
  // adsb.fi allows about 1 request per second, so a short cooldown is enough.
  { name: "adsb.fi", url: (lat: number, lon: number, nm: number) => `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${nm}`, cooldownMs: 5_000 },
];
const cooldownUntil = new Map<string, number>();

async function fetchOnce(): Promise<{ list: Record<string, unknown>[]; provider: string } | { error: string }> {
  const errors: string[] = [];
  for (const p of PROVIDERS) {
    if ((cooldownUntil.get(p.name) ?? 0) > Date.now()) continue;
    try {
      const res = await fetch(p.url(airport.lat, airport.lon, Math.round(airport.radiusNm)), {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "second-sight-hackathon" },
      });
      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const ms = res.status === 429 ? (retryAfter > 0 ? retryAfter * 1000 : p.cooldownMs) : 20_000;
        cooldownUntil.set(p.name, Date.now() + ms);
        errors.push(`${p.name} HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { ac?: Record<string, unknown>[]; aircraft?: Record<string, unknown>[] };
      return { list: body.ac ?? body.aircraft ?? [], provider: p.name };
    } catch (e) {
      cooldownUntil.set(p.name, Date.now() + 10_000);
      errors.push(`${p.name} ${(e as Error).message}`);
    }
  }
  return { error: errors.length ? errors.join("; ") : "all providers cooling down" };
}

const dir = repoPath(`data/recordings/${airport.icao}`);
await mkdir(dir, { recursive: true });
const file = `${dir}/${stamp()}.jsonl`;
console.log(`[record] ${airport.icao} (${airport.name}) radius ${airport.radiusNm} NM, ${minutes} min -> ${file}`);

const POLL_MS = config.pollMs;
const start = Date.now();
const end = start + minutes * 60_000;
let n = 0;
let failedSlots = 0;
let lastTs = 0;
let maxGapMs = 0;
const providerCount = new Map<string, number>();

for (let slot = 0; ; slot++) {
  const slotStart = start + slot * POLL_MS;
  if (slotStart >= end) break;
  const wait = slotStart - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  // Retry inside the slot (leave 500 ms margin) so one 429 doesn't leave a gap.
  let got: Awaited<ReturnType<typeof fetchOnce>> = { error: "not tried" };
  while (Date.now() < slotStart + POLL_MS - 500) {
    got = await fetchOnce();
    if ("list" in got) break;
    await Bun.sleep(1_100);
  }
  if (!("list" in got)) {
    failedSlots++;
    console.warn(`[record] slot ${slot} failed: ${got.error}`);
    continue;
  }
  const ts = Date.now();
  await appendFile(file, JSON.stringify({ ts, ac: got.list.map(trim) }) + "\n");
  if (lastTs) maxGapMs = Math.max(maxGapMs, ts - lastTs);
  lastTs = ts;
  n++;
  providerCount.set(got.provider, (providerCount.get(got.provider) ?? 0) + 1);
  if (n % 12 === 1) console.log(`[record] ${new Date(ts).toISOString()} #${n} ${got.list.length} ac via ${got.provider}`);
}
console.log(
  `[record] done: ${n} snapshots, ${failedSlots} failed slots, max gap ${(maxGapMs / 1000).toFixed(1)} s, providers ${JSON.stringify(Object.fromEntries(providerCount))} -> ${file}`,
);
