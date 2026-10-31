// Parse transcribed transmissions into heard clearances and store them on the EvalLog actor.
//   bun run listener:parse [ICAO] [transmissions.jsonl]
// Callsigns are matched against the ADS-B snapshot recorded closest to each transmission.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { evalLog } from "../../shared/adapters/actors.ts";
import { spokenCallsign } from "../../shared/telephony.ts";
import type { HeardTransmission } from "../../shared/types.ts";
import { parseTransmission } from "../../mastra/src/agents/transmission.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const CONCURRENCY = 8;
const MAX_SNAPSHOT_GAP_MS = 60_000;

type Snap = { ts: number; ac: { hex: string; flight?: string; alt_baro?: number | string }[] };
type Tx = { id: string; feed: string; ts: number; durSec: number; text: string };

function loadSnapshots(icao: string): Snap[] {
  const dir = `${ROOT}data/recordings/${icao}`;
  const snaps: Snap[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) if (line) snaps.push(JSON.parse(line));
  }
  return snaps.sort((a, b) => a.ts - b.ts);
}

function nearest(snaps: Snap[], ts: number): Snap | null {
  let lo = 0;
  let hi = snaps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  const best = [snaps[lo - 1], snaps[lo]].filter(Boolean).sort((a, b) => Math.abs(a!.ts - ts) - Math.abs(b!.ts - ts))[0];
  return best && Math.abs(best.ts - ts) <= MAX_SNAPSHOT_GAP_MS ? best : null;
}

const [icaoArg, fileArg] = process.argv.slice(2);
const icao = (icaoArg ?? "KSFO").toUpperCase();
const file = fileArg ?? `${ROOT}data/atc/${icao}/transmissions.jsonl`;
if (!existsSync(file)) throw new Error(`No transmissions at ${file}. Run: bun run listener pull ${icao}`);

const txs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Tx).filter((t) => t.text.trim());
const snaps = loadSnapshots(icao);
const log = evalLog(icao);
const have = new Set((await log.heard(0, Number.MAX_SAFE_INTEGER)).map((h) => h.id));
const todo = txs.filter((t) => !have.has(t.id));
console.log(`${txs.length} transmissions, ${todo.length} to parse, ${snaps.length} ADS-B snapshots`);

const out: HeardTransmission[] = [];
let next = 0;
let failed = 0;
async function flush(force = false) {
  if (out.length >= 50 || (force && out.length)) await log.addHeard(out.splice(0, out.length));
}
async function loop() {
  while (next < todo.length) {
    const t = todo[next++]!;
    const snap = nearest(snaps, t.ts);
    const ac = (snap?.ac ?? []).filter((a) => a.flight?.trim());
    const candidates = ac.map((a) => ({ callsign: a.flight!.trim(), spoken: spokenCallsign(a.flight!.trim()) }));
    try {
      const p = await parseTransmission(t.text, candidates);
      const match = p.callsign ? ac.find((a) => a.flight!.trim() === p.callsign) : undefined;
      out.push({
        id: t.id,
        feed: t.feed,
        ts: t.ts,
        durSec: t.durSec,
        text: t.text,
        speaker: p.speaker,
        callsign: match ? p.callsign : null,
        hex: match?.hex ?? null,
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
const s = await log.summary();
console.log(`done, ${failed} failed. EvalLog ${icao}: ${s.heard} heard, ${s.withClearance} with a clearance.`);
