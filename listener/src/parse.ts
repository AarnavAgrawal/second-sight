// Parse transcribed transmissions into heard clearances and store them on the EvalLog actor.
//   bun run listener:parse [ICAO] [transmissions.jsonl]
// Callsigns are matched against every aircraft on radar within ±150 s, then a deterministic matching pass runs.
import { existsSync, readFileSync } from "node:fs";
import { evalLog } from "../../shared/adapters/actors.ts";
import { spokenCallsign } from "../../shared/telephony.ts";
import type { HeardTransmission } from "../../shared/types.ts";
import { parseTransmission } from "../../mastra/src/agents/transmission.ts";
import { loadRadar, radarAround, rematch } from "./match.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CONCURRENCY = 8;

type Tx = { id: string; feed: string; ts: number; durSec: number; text: string };



const [icaoArg, fileArg] = process.argv.slice(2);
const icao = (icaoArg ?? "KSFO").toUpperCase();
const file = fileArg ?? `${ROOT}data/atc/${icao}/transmissions.jsonl`;
if (!existsSync(file)) throw new Error(`No transmissions at ${file}. Run: bun run listener pull ${icao}`);

const txs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Tx).filter((t) => t.text.trim());
const radarSnaps = loadRadar(icao);
const log = evalLog(icao);
const have = new Set((await log.heard(0, Number.MAX_SAFE_INTEGER)).map((h) => h.id));
const todo = txs.filter((t) => !have.has(t.id));
console.log(`${txs.length} transmissions, ${todo.length} to parse, ${radarSnaps.length} ADS-B snapshots`);

const out: HeardTransmission[] = [];
let next = 0;
let failed = 0;
async function flush(force = false) {
  if (out.length >= 50 || (force && out.length)) await log.addHeard(out.splice(0, out.length));
}
async function loop() {
  while (next < todo.length) {
    const t = todo[next++]!;
    // Everything on radar within ±150 s: recordings have gaps, and the nearest snapshot alone misses aircraft.
    const radar = radarAround(radarSnaps, t.ts);
    const candidates = [...radar.keys()].map((c) => ({ callsign: c, spoken: spokenCallsign(c) }));
    try {
      const p = await parseTransmission(t.text, candidates);
      const hex = p.callsign ? radar.get(p.callsign.toUpperCase()) : undefined;
      out.push({
        id: t.id,
        feed: t.feed,
        ts: t.ts,
        durSec: t.durSec,
        text: t.text,
        speaker: p.speaker,
        callsign: hex ? p.callsign!.toUpperCase() : null,
        hex: hex ?? null,
        clearances: p.clearances.map((c) => ({ kind: c.kind, value: c.value, ...(c.turn ? { turn: c.turn } : {}) })),
        note: p.note,
      });
      await flush();
    } catch (e) {
      failed++;
      console.error(`parse failed ${t.id}: ${(e as Error).message}`);
    }
    if ((next % 50) === 0) console.log(`  ${next}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, loop));
await flush(true);
const more = await rematch(icao);
console.log("deterministic callsign matching:", more);
const s = await log.summary();
console.log(`done, ${failed} failed. EvalLog ${icao}: ${s.heard} heard, ${s.withClearance} with a clearance.`);
