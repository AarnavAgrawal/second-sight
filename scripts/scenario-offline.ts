// Offline replay scenario check: no bridge, actors, or Relay. Replays a recording + scenario.json through
// the real pure functions and the same filters as bridge/src/poller.ts, then prints what the bridge would post.
//   bun scripts/scenario-offline.ts [ICAO=KSFO] [--scenario path.json] [--recording file.jsonl]
//        [--loops 1] [--accept-after 10] [--resolve-after 0] [--phase 50] [--quiet]
// --accept-after: seconds after BOUNDARY until the receiving sector accepts the handoff (track control flips).
// --resolve-after: seconds after a CA is raised until the agents mark it resolved (0 = never; models suppression).
// Poller behaviour mirrored (keep in sync with poller.ts / source.ts / actor updateTraffic):
//   ReplaySource line pick + startOffsetSec/durationSec window + loop length, applyScenario(elapsedSec),
//   normalizeAdsb -> dropShadows, discrete squawk eligibility, focusCallsigns, approach-corridor rule,
//   CA floor, CA debounce / 2-miss clear / post-resolve suppression, BOUNDARY once per owner, handoff ceiling,
//   track control: owner fixed at first sight until a handoff is accepted; no new owner while a handoff is pending.
import { resolveAirport } from "../bridge/src/airports.ts";
import { config, repoPath } from "../bridge/src/config.ts";
import { applyScenario, type Scenario } from "../bridge/src/scenario.ts";
import { normalizeAdsb } from "../shared/adsb.ts";
import { boundaryApproach } from "../shared/boundary.ts";
import { haversineNm, norm360, sectorOf, toHeading, trueToMag } from "../shared/geo.ts";
import { probeClearance } from "../shared/probe.ts";
import { conflictAlert, projectStraight } from "../shared/separation.ts";
import type { Airport, ClearanceRequest, Position, Sector } from "../shared/types.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const icao = (args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]!.startsWith("--"))) || "KSFO").toUpperCase();
const loops = Number(opt("loops", "1"));
const acceptAfterSec = Number(opt("accept-after", "10"));
const resolveAfterSec = Number(opt("resolve-after", "0"));
const quiet = args.includes("--quiet");
const phaseMs = Number(opt("phase", "50")); // first poll offset; real ticks drift a little, so try a few phases

const r = await resolveAirport(icao);
if ("error" in r) throw new Error(r.error);
const airport: Airport = r.airport;
const dir = repoPath(`data/recordings/${icao}`);
const scenarioPath = opt("scenario") ?? `${dir}/scenario.json`;
const scenario = (await Bun.file(scenarioPath).json()) as Scenario;
const recording = opt("recording") ?? scenario.recording;
if (!recording) throw new Error("no recording (scenario.recording or --recording)");

type Snap = { ts: number; ac: Record<string, unknown>[] };
let lines: Snap[] = (await Bun.file(`${dir}/${recording}`).text())
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Snap;
    } catch {
      return null;
    }
  })
  .filter((x): x is Snap => !!x && Array.isArray(x.ac));
const fullLen = lines.length;
const recSec = (lines.at(-1)!.ts - lines[0]!.ts) / 1000;
if (scenario.startOffsetSec || scenario.durationSec) {
  const t0 = lines[0]!.ts;
  const from = t0 + (scenario.startOffsetSec ?? 0) * 1000;
  const to = scenario.durationSec ? from + scenario.durationSec * 1000 : Infinity;
  lines = lines.filter((l) => l.ts >= from && l.ts <= to);
}
const t0 = lines[0]!.ts;
const loopMs = lines.at(-1)!.ts - t0 + config.pollMs;
console.log(
  `${icao} ${recording}: ${fullLen} snapshots (${recSec.toFixed(0)} s) in file, window ${lines.length} snapshots, loop ${(loopMs / 1000).toFixed(0)} s; ` +
    `scenario ${scenarioPath.replace(/\\/g, "/").split("/").at(-1)}; decl ${airport.declinationDeg}; CA floor ${config.caFloorAglFt} ft AGL; handoff ceiling ${config.handoffCeilingFt}`,
);

// ---- poller.ts replicas ----
const pairKey = (x: string, y: string) => [x, y].sort().join("|");
function dropShadows(positions: Position[]): Position[] {
  const real = positions.filter((p) => !p.hex.startsWith("~"));
  return positions.filter(
    (p) =>
      !p.hex.startsWith("~") ||
      !real.some((r) => haversineNm(p.lat, p.lon, r.lat, r.lon) < 0.5 && Math.abs((p.altFt ?? 0) - (r.altFt ?? 0)) < 300),
  );
}
const focus = scenario.focusCallsigns?.length ? new Set(scenario.focusCallsigns) : null;
const inCorridor = (p: Position) => haversineNm(p.lat, p.lon, airport.lat, airport.lon) < 6 && (p.altFt ?? 0) < airport.elevationFt + 3000;
const floor = airport.elevationFt + config.caFloorAglFt;

// ---- state (actor + poller caches) ----
let trackControl: Record<string, Sector> = {};
const handoffs = new Map<string, { from: Sector; to: Sector; acceptAt: number; callsign: string }>(); // pending
const boundaryEmitted = new Set<string>();
const caLastRaised = new Map<string, number>();
const caMisses = new Map<string, number>();
const caSuppressUntil = new Map<string, number>();
const openCA = new Map<string, { a: string; b: string; raisedAt: number }>();

const fmt = (t: number) => `t=${t.toFixed(1).padStart(6)}s`;
const alt = (p: Position) => `${Math.round((p.altFt ?? 0) / 100).toString().padStart(3, "0")}${p.vertRateFpm > 500 ? "↑" : p.vertRateFpm < -500 ? "↓" : " "}`;
const counts: number[] = [];
const events: string[] = [];
const emit = (s: string) => {
  events.push(s);
  console.log(s);
};
const sims = (scenario.inject ?? []).map((i) => i.callsign);
let firstCaTick: { t: number; pos: Map<string, Position>; all: Position[]; a: string; b: string } | null = null;
let boundaryTick: { t: number; p: Position; all: Position[]; tc: Record<string, Sector> } | null = null;

const totalMs = loopMs * loops;
for (let wall = phaseMs; wall < totalMs; wall += config.pollMs) {
  const elapsed = (wall % loopMs) / 1000;
  const loopN = Math.floor(wall / loopMs);
  const T = wall / 1000; // absolute sim time for caches
  let line = lines[0]!;
  for (const l of lines) {
    if (l.ts - t0 <= elapsed * 1000) line = l;
    else break;
  }
  const ac = applyScenario(scenario, line.ac, elapsed, airport);
  const nowMs = t0 + wall;
  const positions = dropShadows(normalizeAdsb({ ts: nowMs, ac }, airport, nowMs));
  const discrete = new Set(ac.filter((a) => a.squawk != null && String(a.squawk) !== "1200").map((a) => String(a.hex).toLowerCase()));
  const latest = new Map(positions.map((p) => [p.hex, p]));
  counts.push(positions.length);
  const tag = `${loops > 1 ? `L${loopN} ` : ""}${fmt(elapsed)}`;

  // Handoff acceptance (agent): track control flips atomically.
  for (const [hex, h] of [...handoffs]) {
    if (!latest.has(hex)) handoffs.delete(hex);
    else if (T >= h.acceptAt) {
      trackControl = { ...trackControl, [hex]: h.to };
      handoffs.delete(hex);
      emit(`${tag} HANDOFF ${h.callsign} ${h.from}->${h.to} accepted (radar contact; modeled ${acceptAfterSec} s after BOUNDARY)`);
    }
  }
  // Actor updateTraffic.
  const tc: Record<string, Sector> = {};
  for (const p of positions) {
    const owner = trackControl[p.hex];
    if (owner) tc[p.hex] = owner;
    else if (!handoffs.has(p.hex)) tc[p.hex] = sectorOf(p.lat, airport);
  }
  trackControl = tc;

  const eligible = positions.filter((p) => discrete.has(p.hex));
  // Conflicts.
  const preds = conflictAlert(eligible, airport).filter((c) => {
    const a = latest.get(c.hexA);
    const b = latest.get(c.hexB);
    if (!a || !b) return false;
    if (focus && !focus.has(a.callsign) && !focus.has(b.callsign)) return false;
    if (inCorridor(a) && inCorridor(b)) return false;
    return !((a.altFt ?? 0) < floor && (b.altFt ?? 0) < floor);
  });
  // Agents resolve (optional model).
  if (resolveAfterSec > 0) {
    for (const [key, c] of [...openCA]) {
      if (T - c.raisedAt >= resolveAfterSec) {
        openCA.delete(key);
        caSuppressUntil.set(key, T + 180);
        emit(`${tag} CA ${c.a}/${c.b} resolved (modeled ${resolveAfterSec} s after raise; suppressed 3 min)`);
      }
    }
  }
  const predicted = new Set(preds.map((p) => pairKey(p.hexA, p.hexB)));
  for (const p of preds) {
    const key = pairKey(p.hexA, p.hexB);
    caMisses.delete(key);
    const pa = latest.get(p.hexA)!;
    const pb = latest.get(p.hexB)!;
    const sectors = [tc[p.hexA] ?? sectorOf(pa.lat, airport), tc[p.hexB] ?? sectorOf(pb.lat, airport)];
    const line = `${p.a}/${p.b} predicted ${p.minLatNm.toFixed(1)} NM / ${Math.round(p.minVertFt / 100) * 100} FT in ${p.inSec} s (${sectors[0]}/${sectors[1]}) [${p.a} ${alt(pa)} ${p.b} ${alt(pb)}]`;
    if (openCA.has(key)) {
      if (!quiet) console.log(`${tag}   ca-update ${line}`);
      continue;
    }
    if ((caSuppressUntil.get(key) ?? 0) > T) continue;
    if (T - (caLastRaised.get(key) ?? -1e9) < 30) continue;
    openCA.set(key, { a: p.a, b: p.b, raisedAt: T });
    caLastRaised.set(key, T);
    emit(`${tag} CA ${line}`);
    if (!firstCaTick && sims.includes(p.a) && sims.includes(p.b)) firstCaTick = { t: elapsed, pos: latest, all: positions, a: p.a, b: p.b };
  }
  for (const [key, c] of [...openCA]) {
    if (predicted.has(key)) continue;
    const m = (caMisses.get(key) ?? 0) + 1;
    caMisses.set(key, m);
    if (m >= 2) {
      caMisses.delete(key);
      openCA.delete(key);
      emit(`${tag} CA ${c.a}/${c.b} cleared (no longer predicted)`);
    }
  }
  // Boundaries.
  for (const k of [...boundaryEmitted]) {
    const [hex, owner] = k.split(":");
    if (!latest.has(hex!) || tc[hex!] !== owner) boundaryEmitted.delete(k);
  }
  for (const p of focus ? eligible.filter((p) => focus.has(p.callsign)) : eligible) {
    const owner = tc[p.hex];
    if (!owner || handoffs.has(p.hex)) continue;
    if (p.altFt == null || p.altFt >= config.handoffCeilingFt) continue;
    const key = `${p.hex}:${owner}`;
    if (boundaryEmitted.has(key)) continue;
    const b = boundaryApproach(p, airport, owner);
    if (!b) continue;
    boundaryEmitted.add(key);
    handoffs.set(p.hex, { from: b.from, to: b.to, acceptAt: T + acceptAfterSec, callsign: p.callsign });
    emit(`${tag} BOUNDARY ${p.callsign} ${b.from}->${b.to} in ${b.distNm.toFixed(1)} NM, ${alt(p)}`);
    if (!boundaryTick && sims.includes(p.callsign)) boundaryTick = { t: elapsed, p, all: positions, tc: { ...tc } };
  }
}

// ---- summary ----
const nonScripted = events.filter((e) => /\b(CA|BOUNDARY)\b/.test(e) && !/cleared|resolved/.test(e) && !sims.some((s) => e.includes(s)));
console.log(
  `\naircraft per tick: min ${Math.min(...counts)}, avg ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)}, max ${Math.max(...counts)}; non-SIM CA/BOUNDARY events: ${nonScripted.length}`,
);

// Handoff entry point (mirrors mastra check_handoff_entry): receiving sector's traffic projected 90 s vs the entry point.
if (boundaryTick) {
  const { p, all, tc, t } = boundaryTick;
  const to = p.lat >= airport.lat ? "SOUTH" : "NORTH";
  const entry = projectStraight(p, 90);
  console.log(`\nHandoff entry check: ${p.callsign} at ${fmt(t)}, entry point ${entry.lat.toFixed(4)},${entry.lon.toFixed(4)} ${Math.round(entry.altFt ?? 0)} ft (receiving ${to})`);
  const near = all
    .filter((o) => o.hex !== p.hex && tc[o.hex] === to)
    .map((o) => {
      const q = projectStraight(o, 90);
      const now = haversineNm(entry.lat, entry.lon, o.lat, o.lon);
      return { cs: o.callsign, lat90: haversineNm(entry.lat, entry.lon, q.lat, q.lon), v90: Math.abs((entry.altFt ?? 0) - (q.altFt ?? 0)), now, vNow: Math.abs((entry.altFt ?? 0) - (o.altFt ?? 0)) };
    })
    .sort((a, b) => a.lat90 - b.lat90);
  const hits = near.filter((o) => o.lat90 < 3 && o.v90 < 1000);
  console.log(`  ${hits.length ? "NOT CLEAR" : "clear"}: ${hits.map((h) => `${h.cs} ${h.lat90.toFixed(1)} NM/${Math.round(h.v90)} ft`).join(", ") || "no receiving-sector traffic within 3 NM / 1,000 ft"}`);
  const close = near.filter((o) => o.lat90 < 8 && o.v90 < 3000).slice(0, 5);
  if (close.length) console.log(`  closest (8 NM / 3,000 ft): ${close.map((h) => `${h.cs} ${h.lat90.toFixed(1)} NM/${Math.round(h.v90)} ft`).join(", ")}`);
} else console.log("\nHandoff entry check: no SIM BOUNDARY event");

// Resolution options for the scripted CA pair (probeClearance on the tick the CA was raised, all traffic).
if (firstCaTick) {
  const { pos, all, a, b, t } = firstCaTick;
  console.log(`\nResolution probes at ${fmt(t)} for ${a}/${b}:`);
  for (const cs of [a, b]) {
    const p = [...pos.values()].find((x) => x.callsign === cs)!;
    const mag = Math.round(trueToMag(p.trackTrueDeg, airport.declinationDeg));
    const cur = Math.round((p.altFt ?? 0) / 100) * 100;
    const reqs: ClearanceRequest[] = [];
    for (const d of [30, -30, 20, -20, 40, -40, 60, -60]) reqs.push({ kind: "heading", value: toHeading(mag + d), turn: d > 0 ? "right" : "left" });
    const alts = new Set<number>([cur, Math.floor(cur / 1000) * 1000, Math.ceil(cur / 1000) * 1000, Math.ceil(cur / 1000) * 1000 + 1000, Math.floor(cur / 1000) * 1000 - 1000, Math.floor(cur / 1000) * 1000 - 2000]);
    for (const v of alts) reqs.push({ kind: "altitude", value: v });
    console.log(`  ${cs} now ${cur} ft ${Math.round(p.vertRateFpm)} fpm, mag track ${String(mag).padStart(3, "0")} (true ${Math.round(norm360(p.trackTrueDeg))})`);
    for (const q of reqs) {
      const pr = probeClearance(p, q, all, airport);
      const label = q.kind === "heading" ? `turn ${q.turn} heading ${String(q.value).padStart(3, "0")}` : `maintain ${q.value}`;
      console.log(`    ${pr.ok ? "CLEAN" : "fail "} ${label.padEnd(26)} ${pr.ok ? "" : pr.reasons.join(" ")}${pr.alternative ? ` (alt ${pr.alternative.kind} ${pr.alternative.value})` : ""}`);
    }
  }
} else console.log("\nResolution probes: no scripted SIM/SIM CA");
