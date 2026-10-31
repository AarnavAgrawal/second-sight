// Callsign matching pass over stored heard transmissions (EvalLog):
//  0. A parser (LLM) callsign that contradicts the spoken airline + flight number is dropped.
//  1. Transmissions the parser left without a callsign get the deterministic matcher (shared/callsignMatch.ts)
//     against every callsign on radar within ±150 s (not just the nearest snapshot: recordings have gaps).
//  2. A controller clearance still unmatched takes the callsign of the pilot readback that repeats it within 20 s.
//   bun run listener:match [ICAO]
import { readdirSync, readFileSync } from "node:fs";
import { evalLog } from "../../shared/adapters/actors.ts";
import { consistentWithSpoken, matchCallsign, type MatchMethod } from "../../shared/callsignMatch.ts";
import type { HeardTransmission } from "../../shared/types.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const WINDOW_MS = 150_000;
const READBACK_MS = 20_000;

type Snap = { ts: number; byCallsign: Map<string, string> };

export function loadRadar(icao: string): Snap[] {
  const dir = `${ROOT}data/recordings/${icao}`;
  const snaps: Snap[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
      if (!line) continue;
      const s = JSON.parse(line) as { ts: number; ac: { hex: string; flight?: string }[] };
      const byCallsign = new Map<string, string>();
      for (const a of s.ac) if (a.flight?.trim()) byCallsign.set(a.flight.trim().toUpperCase(), a.hex.toLowerCase());
      snaps.push({ ts: s.ts, byCallsign });
    }
  }
  return snaps.sort((a, b) => a.ts - b.ts);
}

/** Callsign -> hex for every aircraft on radar within ±WINDOW_MS of ts. */
export function radarAround(snaps: Snap[], ts: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of snaps) {
    if (s.ts < ts - WINDOW_MS) continue;
    if (s.ts > ts + WINDOW_MS) break;
    for (const [c, h] of s.byCallsign) out.set(c, h);
  }
  return out;
}

const sameClearance = (a: HeardTransmission, b: HeardTransmission) =>
  a.clearances.some((x) => b.clearances.some((y) => x.kind === y.kind && x.value === y.value));

export async function rematch(icao: string): Promise<Record<MatchMethod | "readback" | "rejected", number>> {
  const log = evalLog(icao);
  const rows = (await log.heard(0, Number.MAX_SAFE_INTEGER)).sort((a, b) => a.ts - b.ts);
  const snaps = loadRadar(icao);
  const stats: Record<MatchMethod | "readback" | "rejected", number> = { airline: 0, airline_fuzzy: 0, number: 0, n_number: 0, readback: 0, rejected: 0 };
  const changed = new Map<string, HeardTransmission>();

  for (const r of rows) {
    if (r.callsign && consistentWithSpoken(r.text, r.callsign) === false) {
      r.callsign = null;
      r.hex = null;
      stats.rejected++;
      changed.set(r.id, r);
    }
  }

  for (const r of rows) {
    if (r.callsign) continue;
    const radar = radarAround(snaps, r.ts);
    if (!radar.size) continue;
    const m = matchCallsign(r.text, [...radar.keys()], r.speaker === "controller" ? "start" : r.speaker === "pilot" ? "end" : "any");
    if (!m) continue;
    r.callsign = m.callsign;
    r.hex = radar.get(m.callsign) ?? null;
    stats[m.method]++;
    changed.set(r.id, r);
  }

  for (const [i, r] of rows.entries()) {
    if (r.callsign || r.speaker !== "controller" || !r.clearances.length) continue;
    const rb = rows.slice(i + 1).find((p) => p.ts - r.ts <= READBACK_MS && p.speaker !== "controller" && p.callsign && sameClearance(r, p));
    if (!rb) continue;
    r.callsign = rb.callsign;
    r.hex = rb.hex;
    stats.readback++;
    changed.set(r.id, r);
  }

  const list = [...changed.values()];
  for (let i = 0; i < list.length; i += 50) await log.addHeard(list.slice(i, i + 50));
  return stats;
}

if (import.meta.main) {
  const icao = (process.argv[2] ?? "KSFO").toUpperCase();
  const stats = await rematch(icao);
  const { rejected, ...added } = stats;
  console.log(`rejected ${rejected} parser callsigns that contradict what was said; matched ${Object.values(added).reduce((a, b) => a + b, 0)}:`, added);
}
