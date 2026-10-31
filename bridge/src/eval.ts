// GET /eval/:icao?from=&to=  Shadow evaluation report (mastra/src/eval/evaluate.ts) over recorded ADS-B
// and the transmissions heard on the real frequency (EvalLog actor). Read-only.
import { readdir, readFile, stat } from "node:fs/promises";
import { evalLog } from "../../shared/adapters/actors.ts";
import { normalizeAdsb } from "../../shared/adsb.ts";
import type { Airport, EvalReport, Position } from "../../shared/types.ts";
import { evaluate, type EvalSnapshot } from "../../mastra/src/eval/evaluate.ts";
import { importHeard } from "../../listener/src/seed.ts";
import { resolveAirport } from "./airports.ts";
import { config, repoPath } from "./config.ts";
import { caPairAllowed, dropShadows, squawkSet } from "./filters.ts";

type Loaded = { key: string; snapshots: EvalSnapshot[]; squawked: Set<string> };
const cache = new Map<string, Loaded>();

/** All recordings for the airport, normalized and filtered exactly like the live poller does. Cached by file sizes. */
async function loadSnapshots(icao: string, airport: Airport): Promise<Loaded> {
  const dir = repoPath(`data/recordings/${icao}`);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).sort();
  const sizes = await Promise.all(files.map(async (f) => `${f}:${(await stat(`${dir}/${f}`)).size}`));
  const key = sizes.join("|");
  const hit = cache.get(icao);
  if (hit && hit.key === key) return hit;
  const snapshots: EvalSnapshot[] = [];
  const squawked = new Set<string>();
  for (const f of files) {
    for (const line of (await readFile(`${dir}/${f}`, "utf8")).split("\n")) {
      if (!line) continue;
      const snap = JSON.parse(line) as { ts: number; ac: Record<string, unknown>[] };
      for (const h of squawkSet(snap.ac)) squawked.add(h);
      snapshots.push({ ts: snap.ts, positions: dropShadows(normalizeAdsb(snap, airport, snap.ts)) });
    }
  }
  snapshots.sort((a, b) => a.ts - b.ts);
  const loaded = { key, snapshots, squawked };
  cache.set(icao, loaded);
  return loaded;
}

export async function evalRoute(req: Request, url: URL): Promise<Response | null> {
  const m = /^\/eval\/([A-Za-z0-9]{3,4})$/.exec(url.pathname);
  if (req.method !== "GET" || !m) return null;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const r = await resolveAirport(m[1]!);
  if ("error" in r) return json(r, 404);
  const airport = r.airport;
  const t0 = Date.now();
  let heard = await evalLog(airport.icao).heard(0, Number.MAX_SAFE_INTEGER);
  // Fresh machine: EvalLog is local SQLite, so load the exported seed (data/eval/<ICAO>/heard.jsonl) if there is one.
  if (!heard.length && (await importHeard(airport.icao)) > 0) heard = await evalLog(airport.icao).heard(0, Number.MAX_SAFE_INTEGER);
  const { snapshots, squawked } = await loadSnapshots(airport.icao, airport);
  if (!heard.length) return json({ error: `No heard transmissions for ${airport.icao}. Run the listener (bun run listener backfill ${airport.icao}) or add data/eval/${airport.icao}/heard.jsonl from the machine that has it (bun run listener:export ${airport.icao}).` }, 404);
  const heardFrom = Math.min(...heard.map((h) => h.ts));
  const heardTo = Math.max(...heard.map((h) => h.ts)) + 1;
  const fromTs = Number(url.searchParams.get("from")) || heardFrom;
  const toTs = Number(url.searchParams.get("to")) || heardTo;
  const report: EvalReport = evaluate({
    icao: airport.icao,
    airport,
    snapshots,
    heard,
    fromTs,
    toTs,
    // Same CA eligibility as the live loop: squawked targets (VFR included, TIS-B/no squawk out) plus the CA floor.
    caPairAllowed: (a: Position, b: Position) =>
      squawked.has(a.hex) && squawked.has(b.hex) && caPairAllowed(a, b, airport, config.caFloorAglFt),
  });
  console.log(`[eval] ${airport.icao} ${new Date(fromTs).toISOString().slice(11, 16)}-${new Date(toTs).toISOString().slice(11, 16)}Z: ${report.clearances.length} clearances, ${report.conflicts.length} CAs (${Date.now() - t0} ms)`);
  return json(report);
}
