// Backend check: exercises the bridge HTTP API and actor websockets exactly like the frontend will.
//   bun scripts/backend-check.ts            (bridge on http://localhost:8787, an airport already configured)
// Checks: /health, /config, /airports, /grant + websocket state, /clearance (structured + SSE),
// conformance (pending -> non_conforming with reason), Unable with alternative, Issue alternative.
// Text clearances need ANTHROPIC_API_KEY (parser agent); structured clearances do not.
import { probeClearance } from "../shared/probe.ts";
import { clearancePhrase } from "../shared/phraseology.ts";
import type { Airport, Position, TrafficEntry } from "../shared/types.ts";

const BRIDGE = process.env.BRIDGE_URL || "http://localhost:8787";
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const get = async (p: string) => (await fetch(BRIDGE + p)).json() as Promise<any>;
const post = async (p: string, body: unknown) =>
  (await fetch(BRIDGE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<any>;

/** Open a websocket grant and resolve with the first `state` message; keep applying updates into `state`. */
async function subscribe(actor: string, id: string, onUpdate?: (s: any) => void) {
  const g = await get(`/grant?actor=${actor}&id=${id}`);
  if (!g.websocketUrl) throw new Error(`grant failed: ${JSON.stringify(g)}`);
  const ws = new WebSocket(g.websocketUrl);
  const state: any = {};
  const first = new Promise<any>((resolve) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "state") {
        Object.assign(state, m.state);
        resolve(state);
      } else if (m.type === "state_update") {
        Object.assign(state, m.changes);
        for (const k of m.removed ?? []) delete state[k];
      }
      onUpdate?.(state);
    };
  });
  return { ws, state, first };
}

const toPos = (t: TrafficEntry): Position => ({ ...t, registration: null });

// ---- 1. health / config / airports ----
const health = await get("/health");
ok(health.ok === true && !!health.airport, `/health: airport ${health.airport?.icao}, ${health.aircraftCount} aircraft, relay ${health.relay}`);
const config = await get("/config");
ok(config.dataSource === "live" || config.dataSource === "replay", `/config: dataSource ${config.dataSource}`);
const sfo = await get("/airports/SFO");
ok(sfo.icao === "KSFO" && typeof sfo.elevationFt === "number", `/airports/SFO -> ${sfo.icao} ${sfo.name}`);
const bad = await fetch(BRIDGE + "/airports/KZZQ");
const badBody = await bad.json();
ok(bad.status === 404 && Array.isArray(badBody.suggestions), `/airports/KZZQ -> 404 with ${badBody.suggestions?.length} suggestions`);

// ---- 2. Airspace websocket ----
const sub = await subscribe("Airspace", "main");
const space = await sub.first;
ok(Array.isArray(space.traffic) && space.airport?.icao, `Airspace websocket state: ${space.traffic.length} traffic, airport ${space.airport?.icao}`);
const airport = space.airport as Airport;
const traffic = space.traffic as TrafficEntry[];
const positions = traffic.map(toPos);

// ---- 3. Non-conformance: climbing aircraft cleared to descend ----
const climber = traffic
  .filter((t) => t.altFt != null && t.vertRateFpm > 800 && t.altFt > 5000 && t.status === "none" && /^[A-Z]{3}\d/.test(t.callsign))
  .sort((a, b) => b.vertRateFpm - a.vertRateFpm)[0];
if (!climber) {
  console.log("SKIP  no climbing airline aircraft above 5,000 ft right now");
} else {
  const target = 4000;
  const res = await post("/clearance", { text: clearancePhrase(climber.callsign, { kind: "altitude", value: target }, climber.altFt), clearance: { callsign: climber.callsign, kind: "altitude", value: target }, override: true });
  ok(res.issued === true, `issue ${climber.callsign} descend to 4,000 (CIC override so the probe can't block it): ${res.phraseology ?? res.reason}`);
  const seen: string[] = [];
  const ac = await subscribe("Aircraft", climber.hex, (s) => {
    const tag = `${s.status}: ${s.statusReason}`;
    if (seen.at(-1) !== tag) seen.push(tag);
  });
  await ac.first;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && ac.state.status !== "non_conforming") await Bun.sleep(1000);
  ac.ws.close();
  console.log("      status history:\n        " + seen.join("\n        "));
  ok(seen.some((x) => x.startsWith("pending")), "went pending (amber) first");
  ok(ac.state.status === "non_conforming", `went non_conforming (red): "${ac.state.statusReason}"`);
}

// ---- 4. Unable with alternative: find a clearance that the probe rejects for traffic ----
let unableCase: { cs: string; value: number; alt: boolean } | null = null;
const candidates: { cs: string; value: number; alt: boolean }[] = [];
for (const a of traffic) {
  if (a.altFt == null || a.status !== "none" || !/^[A-Z]{3}\d/.test(a.callsign)) continue;
  for (const b of traffic) {
    if (b.hex === a.hex || b.altFt == null) continue;
    const value = Math.round(b.altFt / 100) * 100;
    if (value < airport.elevationFt + 1600 || Math.abs(value - a.altFt) < 1000) continue;
    const pr = probeClearance(toPos(a), { kind: "altitude", value }, positions, airport);
    if (!pr.ok && pr.conflicts.length) candidates.push({ cs: a.callsign, value, alt: !!pr.alternative });
  }
}
unableCase = candidates.find((c) => c.alt) ?? candidates[0] ?? null;
if (!unableCase) {
  console.log("SKIP  no clearance-into-traffic case in current traffic");
} else {
  const r = await post("/clearance", { text: `${unableCase.cs} ${unableCase.value}`, clearance: { callsign: unableCase.cs, kind: "altitude", value: unableCase.value } });
  ok(r.issued === false && !!r.reason, `Unable: ${r.reason}`);
  if (unableCase.alt) ok(!!r.alternative?.text && !!r.alternative?.callsign, `alternative offered: ${r.alternative?.text}`);
  else console.log("      (probe found no clean alternative for this case; that is valid)");
  ok(r.probe?.ok === false && r.probe?.conflicts?.length > 0, `probe attached with ${r.probe?.conflicts?.length} conflict(s)`);
  if (r.alternative) {
    const alt = r.alternative;
    const r2 = await post("/clearance", { text: alt.text, clearance: { callsign: alt.callsign, kind: alt.kind, value: alt.value, ...(alt.turn ? { turn: alt.turn } : {}) } });
    ok(r2.issued === true || /No response from sector/.test(r2.reason ?? ""), `Issue alternative -> ${r2.issued ? `issued: ${r2.phraseology}` : r2.reason}`);
  }
}

// ---- 5. SSE streaming ----
const anyAc = traffic.find((t) => t.altFt != null && /^[A-Z]{3}\d/.test(t.callsign) && t.status === "none");
if (anyAc) {
  const res = await fetch(BRIDGE + "/clearance", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text: "x", clearance: { callsign: anyAc.callsign, kind: "altitude", value: 45000 + 1000 } }),
  });
  const body = await res.text();
  const events = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  ok(res.headers.get("content-type")?.includes("text/event-stream") === true && events.includes("step") && events.at(-1) === "result", `SSE events: ${events.join(", ")}`);
}

sub.ws.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll backend checks passed");
process.exit(failures ? 1 : 0);
