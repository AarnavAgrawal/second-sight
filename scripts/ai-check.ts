export {};
// Live check of the AI controller behaviors (ai-updates.md 12 demo beats) through the HTTP API, like the UI.
//   bun scripts/ai-check.ts            (bridge + agents running: `bun run backend`; any airport configured)
//   bun scripts/ai-check.ts replay     (also runs the KSFO replay scenario and the "AI remembers" agreement beat)
import { generateCandidates } from "../shared/candidates.ts";
import { probeClearance } from "../shared/probe.ts";
import { sectorEntry } from "../shared/sectorEntry.ts";
import { DIGIT_WORDS, numberWords, spokenCallsign, telephonyOf } from "../shared/telephony.ts";
import type { Airport, Position, Sector, TrafficEntry } from "../shared/types.ts";

const BRIDGE = process.env.BRIDGE_URL || "http://localhost:8787";
const withReplay = process.argv[2] === "replay";
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) fails++;
};
const post = async (p: string, b: unknown) => {
  const t0 = Date.now();
  const r = await fetch(BRIDGE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  const j = (await r.json()) as any;
  j._ms = Date.now() - t0;
  j._status = r.status;
  return j;
};
const toPos = (t: TrafficEntry): Position => ({ ...t, registration: null });
const isAirline = (cs: string) => /^[A-Z]{3}\d/.test(cs) && !!telephonyOf(cs);
const show = (r: any) =>
  `${r.issued ? "ISSUED" : r.needsConfirm ? "CONFIRM?" : "NOT ISSUED"} in ${r._ms} ms | review ${r.review?.by}/${r.review?.decision}: "${r.review?.reason}"` +
  `${r.reason ? ` | reason: "${r.reason}"` : ""}${r.alternative ? ` | alt ${r.alternative.candidateId ?? "-"}: "${r.alternative.text}"` : ""}` +
  ` | steps: ${(r.steps ?? []).map((s: any) => `${s.id}:${s.status}`).join(" ")}`;

async function airspaceState(): Promise<any> {
  const g = (await (await fetch(BRIDGE + "/grant?actor=Airspace&id=main")).json()) as any;
  const ws = new WebSocket(g.websocketUrl);
  const s = await new Promise<any>((res) => (ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "state") res(m.state); }));
  ws.close();
  return s;
}

const s = await airspaceState();
const airport = s.airport as Airport;
const traffic = (s.traffic as TrafficEntry[]).filter((t) => t.altFt != null && t.status === "none");
const positions = (s.traffic as TrafficEntry[]).map(toPos);
const owner = (t: TrafficEntry) => (s.trackControl[t.hex] ?? (t.lat >= airport.lat ? "NORTH" : "SOUTH")) as Sector;
console.log(`Airport ${airport.icao}, ${traffic.length} aircraft without clearances\n`);

// 1. AI picks the smart option: a clearance into traffic that has safe candidates.
{
  let pick: { t: TrafficEntry; value: number } | null = null;
  outer: for (const t of traffic.filter((x) => isAirline(x.callsign))) {
    for (const o of positions) {
      if (o.hex === t.hex || o.altFt == null) continue;
      const value = Math.round(o.altFt / 1000) * 1000;
      if (value < airport.elevationFt + 2000 || Math.abs(value - t.altFt!) < 1000) continue;
      const req = { kind: "altitude" as const, value };
      const pr = probeClearance(toPos(t), req, positions, airport);
      if (pr.ok || !pr.conflicts.length || pr.conflicts[0]!.inSec < 30) continue;
      if (sectorEntry(toPos(t), req, airport, owner(t)).entersOther) continue;
      if (generateCandidates(toPos(t), req, positions, airport, { owner: owner(t) }).length < 2) continue;
      pick = { t, value };
      break outer;
    }
  }
  if (!pick) console.log("SKIP  smart-option beat: no clearance-into-traffic case right now");
  else {
    const r = await post("/clearance", { text: "x", clearance: { callsign: pick.t.callsign, kind: "altitude", value: pick.value } });
    console.log(`      ${pick.t.callsign} to ${pick.value}: ${show(r)}`);
    if (r.probe?.ok) console.log("SKIP  traffic moved; probe passed at request time");
    else {
      ok(r.issued === false && r.review?.decision === "unable", "smart option: Unable");
      ok(r.review?.by === "NORTH" || r.review?.by === "SOUTH", `smart option: decided by the sector agent (by=${r.review?.by})`);
      ok(!!r.alternative?.candidateId && (r.probe?.alternatives ?? []).some((c: any) => c.id === r.alternative.candidateId), "smart option: alternative is a math candidate id");
      ok((r.review?.reason ?? "").length > 10, `smart option: "Why this option": ${r.review?.reason}`);
    }
  }
}

// 2. Issue: a climbing airliner cleared further up, staying in its sector.  3. Confirm: reverse it right away.
{
  const climber = traffic
    .filter((t) => isAirline(t.callsign) && t.vertRateFpm > 800 && t.altFt! > 3000 && t.altFt! < 14000)
    .find((t) => {
      const req = { kind: "altitude" as const, value: Math.ceil((t.altFt! + 3000) / 1000) * 1000 };
      return probeClearance(toPos(t), req, positions, airport).ok && !sectorEntry(toPos(t), req, airport, owner(t)).entersOther;
    });
  if (!climber) console.log("SKIP  issue/confirm beats: no suitable climbing airliner right now");
  else {
    const up = Math.ceil((climber.altFt! + 3000) / 1000) * 1000;
    const text = `${spokenCallsign(climber.callsign)}, climb and maintain ${up}`;
    const r = await post("/clearance", { text });
    console.log(`      "${text}": ${show(r)}`);
    ok(r.issued === true && r.review?.decision === "issue", `issue beat (by ${r.review?.by})`);
    const down = Math.max(Math.ceil((airport.elevationFt + 2000) / 1000) * 1000, Math.floor((climber.altFt! - 4000) / 1000) * 1000);
    const r2 = await post("/clearance", { text: "x", clearance: { callsign: climber.callsign, kind: "altitude", value: down } });
    console.log(`      reversal to ${down}: ${show(r2)}`);
    ok(r2.needsConfirm === true || r2.review?.decision === "confirm" || r2.review?.decision === "unable", "confirm beat: reversal is not silently issued");
    if (r2.needsConfirm) {
      ok(!!r2.question, `confirm question: "${r2.question}"`);
      const r3 = await post("/clearance", { text: "x", clearance: { callsign: climber.callsign, kind: "altitude", value: down }, confirmed: true });
      console.log(`      confirmed: ${show(r3)}`);
      ok(r3.needsConfirm !== true, "confirmed resend is decided (issued or unable), not asked again");
    }
  }
}

// 4. Coordinate: a safe clearance for an aircraft that will cross the sector boundary within 120 s.
{
  let pick: { t: TrafficEntry; value: number } | null = null;
  for (const t of traffic.filter((x) => isAirline(x.callsign))) {
    const value = Math.round(t.altFt! / 100) * 100;
    const req = { kind: "altitude" as const, value };
    const e = sectorEntry(toPos(t), req, airport, owner(t));
    if (!e.entersOther || (e.inSec ?? 0) < 30) continue;
    if (!probeClearance(toPos(t), req, positions, airport).ok) continue;
    pick = { t, value };
    break;
  }
  if (!pick) console.log("SKIP  coordinate beat: no aircraft about to cross the line right now");
  else {
    const r = await post("/clearance", { text: "x", clearance: { callsign: pick.t.callsign, kind: "altitude", value: pick.value } });
    console.log(`      ${pick.t.callsign} maintain ${pick.value} (crossing): ${show(r)} | pointOut ${JSON.stringify(r.review?.pointOut)}`);
    ok(r.review?.decision === "coordinate" || r.review?.by === "FALLBACK", `coordinate beat: decision ${r.review?.decision}`);
    if (r.review?.decision === "coordinate") ok(!!r.review?.pointOut, `point out result: ${r.review?.pointOut?.result}`);
  }
}

// 5. Say again: ambiguous partial callsign ("Southwest twenty-one" with SWA2140 and SWA2155 in range).
{
  const groups = new Map<string, TrafficEntry[]>();
  for (const t of s.traffic as TrafficEntry[]) {
    const m = t.callsign.match(/^([A-Z]{3})(\d\d)\d\d$/);
    if (m && telephonyOf(t.callsign)) groups.set(m[1]! + m[2]!, [...(groups.get(m[1]! + m[2]!) ?? []), t]);
  }
  const amb = [...groups.values()].find((g) => g.length >= 2);
  if (!amb) console.log("SKIP  say-again beat: no two same-airline callsigns sharing the first two digits");
  else {
    const n = Number(amb[0]!.callsign.slice(3, 5));
    const text = `${telephonyOf(amb[0]!.callsign)} ${n >= 10 ? numberWords(n) : DIGIT_WORDS[n]}, climb and maintain one zero thousand`;
    const r = await post("/clearance", { text });
    console.log(`      "${text}" (${amb.map((a) => a.callsign).join(", ")}): HTTP ${r._status} "${r.reason}" options=${JSON.stringify(r.options)}`);
    ok(r.sayAgain === true && r._status === 422, "say again on an ambiguous callsign");
  }
}

// 6. AI remembers (replay): APREQ creates an agreement; a clearance that breaks it is refused or questioned.
if (withReplay) {
  await post("/source", { dataSource: "replay" });
  console.log("\n      replay started; waiting for the APREQ agreement ...");
  let ag: any = null;
  for (let i = 0; i < 25 && !ag; i++) {
    await Bun.sleep(2000);
    const st = await airspaceState();
    ag = (st.agreements ?? []).find((a: any) => a.state === "active");
  }
  ok(!!ag, `agreement stored: ${ag?.text ?? "none"}`);
  if (ag) {
    const c = ag.constraint;
    const clearance =
      c.kind === "altitude"
        ? { callsign: ag.callsign, kind: "altitude", value: c.value + (c.value >= 9000 ? -2000 : 2000) }
        : { callsign: ag.callsign, kind: "heading", value: ((c.value + 40 - 1) % 360) + 1, turn: "right" };
    const r = await post("/clearance", { text: "x", clearance });
    console.log(`      ${ag.callsign} ${clearance.kind} ${clearance.value} vs "${ag.text}": ${show(r)}`);
    ok(!r.issued && (r.review?.decision === "unable" || r.review?.decision === "confirm"), "AI remembers: breaking the agreement is refused or questioned");
  }
}

console.log(fails ? `\n${fails} check(s) FAILED` : "\nAll AI checks passed (skips are traffic-dependent)");
process.exit(fails ? 1 : 0);
