// Offline shadow-evaluation report: the same evaluate() run as GET /eval/:icao (bridge/src/eval.ts), but from
// files only (no network, no actors). Loads data/recordings/<ICAO>/*.jsonl and data/eval/<ICAO>/heard.jsonl,
// applies the live poller's filters (dropShadows, squawked targets, caPairAllowed with config.caFloorAglFt),
// prints the KPIs and every "unable" ruling with its conflict and whether the pair actually got close.
//   bun scripts/eval-report.ts [ICAO]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAdsb } from "../shared/adsb.ts";
import { haversineNm } from "../shared/geo.ts";
import { minimaFor } from "../shared/separation.ts";
import type { ClearanceEval, HeardTransmission, Position, SeparationBasis } from "../shared/types.ts";
import { evaluate, type EvalSnapshot } from "../mastra/src/eval/evaluate.ts";
import { resolveAirport } from "../bridge/src/airports.ts";
import { config } from "../bridge/src/config.ts";
import { caPairAllowed, dropShadows, squawkSet } from "../bridge/src/filters.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const icao = (process.argv[2] ?? "KSFO").toUpperCase();
const r = await resolveAirport(icao);
if ("error" in r) throw new Error(r.error);
const airport = r.airport;

const recDir = join(ROOT, "data", "recordings", icao);
const snapshots: EvalSnapshot[] = [];
const squawked = new Set<string>();
for (const f of readdirSync(recDir).filter((x) => x.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join(recDir, f), "utf8").split("\n")) {
    if (!line) continue;
    const snap = JSON.parse(line) as { ts: number; ac: Record<string, unknown>[] };
    for (const h of squawkSet(snap.ac)) squawked.add(h);
    snapshots.push({ ts: snap.ts, positions: dropShadows(normalizeAdsb(snap, airport, snap.ts)) });
  }
}
snapshots.sort((a, b) => a.ts - b.ts);

const heardFile = join(ROOT, "data", "eval", icao, "heard.jsonl");
if (!existsSync(heardFile)) throw new Error(`No ${heardFile}`);
const heard = readFileSync(heardFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HeardTransmission);
const fromTs = Math.min(...heard.map((h) => h.ts));
const toTs = Math.max(...heard.map((h) => h.ts)) + 1;

const t0 = Date.now();
const report = evaluate({
  icao,
  airport,
  snapshots,
  heard,
  fromTs,
  toTs,
  caPairAllowed: (a: Position, b: Position) => squawked.has(a.hex) && squawked.has(b.hex) && caPairAllowed(a, b, airport, config.caFloorAglFt),
});
const ms = Date.now() - t0;

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const k = report.kpis as Record<string, number>;
console.log(`${icao}: ${snapshots.length} snapshots, ${heard.length} heard, ${report.clearances.length} clearances, ${report.conflicts.length} CAs (${ms} ms)`);
console.log("kpis", JSON.stringify(k));
const ruled = report.clearances.filter((c) => c.ruling);
const scored = k.issue! + k.coordinate! + k.unable!;
console.log(`agreed (old metric): ${k.agreed}/${scored} = ${pct(k.agreed!, scored)}`);
console.log(`would issue: ${k.issue! + k.coordinate!}/${ruled.length} = ${pct(k.issue! + k.coordinate!, ruled.length)}`);
if (k.observed != null) console.log(`agreed (outcome observed): ${k.agreedObserved}/${k.observed} = ${pct(k.agreedObserved!, k.observed)}; in progress ${k.inProgress}; unable actually close ${k.unableActuallyClose}/${k.unable}`);

/** Closest actual approach over 150 s from recorded snapshots (independent check of the report). */
function actualClose(c: ClearanceEval, otherCallsign: string, latNm: number, vertFt: number) {
  let otherHex: string | null = null;
  let minLat = Infinity;
  let vertAtMin: number | null = null;
  let inside = false;
  for (const s of snapshots) {
    if (s.ts < c.ts - 15_000 || s.ts > c.ts + 150_000) continue;
    const a = s.positions.find((p) => p.hex === c.hex);
    const b: Position | undefined = otherHex ? s.positions.find((p) => p.hex === otherHex) : s.positions.find((p) => p.callsign === otherCallsign);
    if (!a || !b) continue;
    otherHex = b.hex;
    if (s.ts < c.ts) continue;
    const lat = haversineNm(a.lat, a.lon, b.lat, b.lon);
    const vert = a.altFt != null && b.altFt != null ? Math.abs(a.altFt - b.altFt) : null;
    if (lat < minLat) (minLat = lat), (vertAtMin = vert);
    if (vert != null && lat < latNm && vert < vertFt) inside = true;
  }
  return { minLat: Number.isFinite(minLat) ? Math.round(minLat * 10) / 10 : null, vertAtMin: vertAtMin == null ? null : Math.round(vertAtMin), inside };
}

const unables = ruled.filter((c) => c.ruling!.decision === "unable");
console.log(`\nUnable rulings (${unables.length}):`);
for (const c of unables) {
  const ru = c.ruling!;
  const req = c.req.kind === "altitude" ? `ALT ${c.req.value}` : `HDG ${String(c.req.value).padStart(3, "0")}${c.req.turn ? ` ${c.req.turn}` : ""}`;
  const head = `${new Date(c.ts).toISOString().slice(11, 19)}Z ${c.callsign.padEnd(8)} ${req.padEnd(12)} phase=${ru.phase} outcome=${c.outcome.result}`;
  if (ru.note) console.log(`      note: ${ru.note}`);
  if (!ru.conflicts.length) {
    console.log(`  ${head}\n      no probe conflict: ${ru.reason}`);
    continue;
  }
  for (const cf of ru.conflicts) {
    const basis: SeparationBasis = cf.basis ?? "standard";
    const { latNm, vertFt } = minimaFor(basis);
    const a = actualClose(c, cf.with, latNm, vertFt);
    console.log(
      `  ${head}\n      vs ${cf.with} basis=${basis} predicted ${cf.minLatNm} NM / ${cf.minVertFt} ft in ${cf.inSec} s; actual closest ${a.minLat ?? "-"} NM / ${a.vertAtMin ?? "-"} ft -> ${a.inside ? "CAME INSIDE" : "stayed outside"} ${latNm}/${vertFt}`,
    );
  }
}

const notes = ruled.filter((c) => c.ruling!.decision !== "unable" && c.ruling!.note);
console.log(`
Issued thanks to heard context (${notes.length}):`);
for (const c of notes) console.log(`  ${new Date(c.ts).toISOString().slice(11, 19)}Z ${c.callsign.padEnd(8)} ${c.ruling!.note}`);
