export {};
// Replay scenario check (CLAUDE.md Phase 5 "done when": the scenario runs the same way three times in a row).
//   bun scripts/scenario-check.ts [runs=1] [seconds=120]
// Restarts replay via POST /source, watches the Airspace websocket, prints a timeline, and checks:
//   - a cross-sector CA (SIM101/SIM202, NORTH/SOUTH) is raised
//   - BOUNDARY for SIM303 is posted and a handoff starts
//   - with agents running: APREQ exchange on Relay, CA ends resolved or escalated, handoff accepted (track control flips)
const BRIDGE = process.env.BRIDGE_URL || "http://localhost:8787";
const runs = Number(process.argv[2] || 1);
const seconds = Number(process.argv[3] || 120);

async function oneRun(n: number): Promise<{ ok: boolean; summary: string }> {
  const res = await fetch(BRIDGE + "/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataSource: "replay" }) });
  const body = (await res.json()) as any;
  if (!res.ok) return { ok: false, summary: `replay failed to start: ${body.error}` };
  const t0 = Date.now();
  const at = () => `t+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
  const g = (await (await fetch(BRIDGE + "/grant?actor=Airspace&id=main")).json()) as any;
  const ws = new WebSocket(g.websocketUrl);
  const state: any = {};
  const seenFeed = new Set<string>();
  const seenConf = new Map<string, string>();
  const seenHo = new Map<string, string>();
  const events: string[] = [];
  const log = (s: string) => {
    events.push(`${at()} ${s}`);
    console.log(`  [run ${n}] ${at()} ${s}`);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "state") Object.assign(state, m.state);
    else if (m.type === "state_update") Object.assign(state, m.changes);
    else return;
    for (const f of state.feed ?? []) {
      const k = `${f.ts}|${f.from}|${f.text}`;
      if (seenFeed.has(k) || f.ts < t0 - 2000) continue;
      seenFeed.add(k);
      log(`FEED ${f.from} -> ${f.to}: ${f.text}`);
    }
    for (const c of state.conflicts ?? []) {
      const k = `${c.state}|${c.resolution ?? ""}`;
      if (seenConf.get(c.id) === k) continue;
      seenConf.set(c.id, k);
      log(`CONFLICT ${c.a}/${c.b} (${c.sectors.join("/")}) ${c.state}${c.resolution ? `: ${c.resolution}` : ""}`);
    }
    for (const h of state.handoffs ?? []) {
      const k = h.state;
      if (seenHo.get(h.hex) === k) continue;
      seenHo.set(h.hex, k);
      log(`HANDOFF ${h.callsign} ${h.from}->${h.to} ${h.state} (track control: ${state.trackControl?.[h.hex]})`);
    }
  };
  await Bun.sleep(seconds * 1000);
  ws.close();
  const has = (re: RegExp) => events.some((e) => re.test(e));
  const checks = {
    crossSectorCA: has(/CONFLICT SIM101\/SIM202 \(NORTH\/SOUTH\) active/),
    boundary: has(/BOUNDARY SIM303 SOUTH->NORTH/),
    handoffStarted: has(/HANDOFF SIM303 SOUTH->NORTH pending/),
    apreq: has(/APREQ/),
    caEnded: has(/CONFLICT SIM101\/SIM202 .* (resolved|escalated)/),
    handoffAccepted: has(/HANDOFF SIM303 SOUTH->NORTH accepted \(track control: NORTH\)/),
    radarContact: has(/radar contact/i),
  };
  const summary = Object.entries(checks).map(([k, v]) => `${v ? "✓" : "✗"} ${k}`).join("  ");
  return { ok: checks.crossSectorCA && checks.boundary, summary };
}

const results: string[] = [];
for (let i = 1; i <= runs; i++) {
  console.log(`\n=== Run ${i}/${runs} ===`);
  const r = await oneRun(i);
  results.push(`run ${i}: ${r.summary}`);
}
console.log("\n" + results.join("\n"));
