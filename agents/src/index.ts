// Agent runner: one process per identity (bun run agent NORTH | SOUTH | MONITOR).
// Connects a Mastra agent to Agent Relay. Routing (which events need a turn) is deterministic code;
// each turn gets the event, its structured payload, probe-checked options, and related recent messages.
import { createMonitorAgent, createSectorAgent } from "../../mastra/src/agents/controllers.ts";
import { probeFor } from "../../mastra/src/ops.ts";
import { turn, type Identity, type TurnContext } from "../../mastra/src/tools/index.ts";
import { getView } from "../../mastra/src/view.ts";
import { aircraft, airspace } from "../../shared/adapters/actors.ts";
import { Relay, type RelayMessage } from "../../shared/adapters/relay.ts";
import { handoffPhrase, unablePhrase } from "../../shared/phraseology.ts";
import { formatAltitude } from "../../shared/conformance.ts";
import { spokenCallsign } from "../../shared/telephony.ts";
import type { ClearanceRequest, ProbeResult, Sector } from "../../shared/types.ts";

const me = (process.argv[2] || "").toUpperCase() as Identity;
if (!["NORTH", "SOUTH", "MONITOR"].includes(me)) {
  console.error("Usage: bun run agent NORTH | SOUTH | MONITOR");
  process.exit(1);
}
const other: Sector | null = me === "NORTH" ? "SOUTH" : me === "SOUTH" ? "NORTH" : null;
const MAX_STEPS = 5; // 4 tool rounds + final answer
const STALE_MS = 60_000;

const relay = await Relay.connect(me, {
  type: "agent",
  persona: me === "MONITOR" ? "Conformance monitoring agent." : `${me} sector controller agent.`,
});
const agent = me === "MONITOR" ? createMonitorAgent() : createSectorAgent(me as Sector);
let session = (await airspace().getAirport()).session;
console.log(`[${me}] connected to Relay; session ${session}; model ready`);

interface Job {
  key: string;
  msg: RelayMessage;
  type: string;
  priority: number;
  enqueuedAt: number;
  task: string;
  conflictId?: string;
  requestId?: string;
}
const queue: Job[] = [];
const seen = new Map<string, number>();
const history: RelayMessage[] = [];
const directions: { ts: number; text: string }[] = [];
const apreqRounds = new Map<string, number>();

type Data = Record<string, any>;
const dataOf = (m: RelayMessage): Data => (m.data ?? {}) as Data;
const sp = (cs: string) => spokenCallsign(cs);
const once = (key: string) => {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
};
const remember = (m: RelayMessage) => {
  history.push(m);
  if (history.length > 60) history.shift();
};

function relatedMessages(terms: string[], exceptId: string): string {
  const t = terms.filter(Boolean).map((x) => x.toUpperCase());
  const rel = history.filter((m) => m.id !== exceptId && t.some((x) => m.text.toUpperCase().includes(x) || JSON.stringify(m.data ?? {}).toUpperCase().includes(x))).slice(-6);
  return rel.length ? rel.map((m) => `- ${m.from} -> ${m.to}: ${m.text}`).join("\n") : "(none)";
}

function standingDirections(): string {
  const now = Date.now();
  const live = directions.filter((d) => now - d.ts < 10 * 60_000);
  return live.length ? live.map((d) => `- [${Math.round((now - d.ts) / 1000)} s ago] ${d.text}`).join("\n") : "(none)";
}

/** Deterministic, probe-checked resolution options for a conflict (rules compute facts; the agent chooses). */
async function resolutionOptions(callsigns: string[], trafficCs: Record<string, string>): Promise<string> {
  const view = await getView();
  const decl = view.airport?.declinationDeg ?? 0;
  const lines: string[] = [];
  for (const cs of callsigns) {
    const t = view.traffic.find((x) => x.callsign === cs);
    if (!t || t.altFt == null) continue;
    const cands: ClearanceRequest[] = [];
    if (t.vertRateFpm > 500) cands.push({ kind: "altitude", value: Math.ceil((t.altFt + 300) / 1000) * 1000 });
    if (t.vertRateFpm < -500) cands.push({ kind: "altitude", value: Math.floor((t.altFt - 300) / 1000) * 1000 });
    const mag = (((t.trackTrueDeg - decl) % 360) + 360) % 360;
    for (const d of [30, -30]) {
      let h = Math.round((mag + d) / 10) * 10;
      h = ((h % 360) + 360) % 360 || 360;
      cands.push({ kind: "heading", value: h, turn: d > 0 ? "right" : "left" });
    }
    for (const req of cands) {
      const r = await probeFor(cs, req, view);
      if (r.ok && r.probe.ok) {
        lines.push(
          `- ${r.phraseology} (probe clean${trafficCs[cs] ? `, for traffic ${sp(trafficCs[cs]!)}` : ""}) -> args {callsign:"${cs}", kind:"${req.kind}", value:${req.value}${req.turn ? `, turn:"${req.turn}"` : ""}}`,
        );
      }
    }
  }
  return lines.length ? lines.join("\n") : "(no clean option found by probe)";
}

// ---------------- routing ----------------

async function route(m: RelayMessage): Promise<void> {
  remember(m);
  const d = dataOf(m);
  if (typeof d.session === "number" && d.session < session) return; // stale airport

  if (m.from === "RADAR" && d.type === "SESSION") {
    session = d.session ?? session + 1;
    queue.length = 0;
    directions.length = 0;
    apreqRounds.clear();
    console.log(`[${me}] SESSION ${d.airport?.icao ?? ""}: dropped pending work`);
    return;
  }

  if (me === "MONITOR") {
    if (m.from === "RADAR" && d.type === "NONCONF" && once(`NONCONF:${d.hex}:${d.clearance?.issuedAt}`)) {
      enqueue(m, 2, `NONCONF:${d.hex}`, "NONCONF", monitorTask(d));
    }
    return;
  }

  // ---- sector controllers ----
  if (m.kind === "dm" && m.from === "CIC" && d.type === "CLEARANCE_REQUEST" && once(`CLR:${d.requestId}`)) {
    return enqueue(m, 0, `CLR:${d.requestId}`, "CLEARANCE_REQUEST", clearanceTask(d), { requestId: d.requestId });
  }
  if (m.from === "RADAR" && d.type === "BOUNDARY" && d.from === me && once(`BOUNDARY:${d.hex}:${d.from}:${session}`)) {
    return enqueue(m, 1, `BOUNDARY:${d.hex}`, "BOUNDARY", await boundaryTask(d));
  }
  if (m.from === "RADAR" && d.type === "CA" && once(`CA:${d.id}`)) {
    const [sa, sb] = d.sectors as [Sector, Sector];
    if (sa !== sb && sa === me) return enqueue(m, 1, `CA:${d.id}`, "CA_CROSS", await apreqInitTask(d), { conflictId: d.id });
    if (sa === sb && sa === me) return enqueue(m, 2, `CA:${d.id}`, "CA_SAME", await sameSectorTask(d), { conflictId: d.id });
    return;
  }
  if (m.kind === "dm" && m.from === other && once(`DM:${m.id}`)) {
    if (d.type === "HANDOFF") return enqueue(m, 1, `HO:${m.id}`, "HANDOFF_IN", handoffInTask(m, d));
    if (d.type === "APREQ" || (d.type === "APREQ_REPLY" && d.approved === false)) {
      const id = d.conflictId as string | undefined;
      const round = id ? (apreqRounds.get(id) ?? 0) + 1 : 1;
      if (id) apreqRounds.set(id, round);
      return enqueue(m, 1, `AP:${m.id}`, "APREQ_IN", await apreqInTask(m, d, round), { conflictId: id });
    }
    if (d.type === "APREQ_REPLY" && d.approved === true) {
      return enqueue(m, 1, `AP:${m.id}`, "APREQ_APPROVED", apreqApprovedTask(m, d), { conflictId: d.conflictId });
    }
    return; // RADAR_CONTACT, UNABLE (handoff), INFO, ACK: no turn needed
  }
  if (m.kind === "dm" && m.from === "MONITOR" && d.type === "NONCONF" && once(`NC:${m.id}`)) {
    return enqueue(m, 2, `NC:${m.id}`, "NONCONF_DM", nonconfDmTask(m, d));
  }
  if (m.from === "CIC" && m.to === "#cic" && d.type !== "OVERRIDE" && once(`CIC:${m.id}`)) {
    directions.push({ ts: Date.now(), text: m.text });
    return enqueue(m, 1, `CIC:${m.id}`, "CIC", cicTask(m));
  }
}

function enqueue(m: RelayMessage, priority: number, key: string, type: string, task: string, extra: { conflictId?: string; requestId?: string } = {}) {
  queue.push({ key, msg: m, type, priority, enqueuedAt: Date.now(), task, ...extra });
  queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
  void work();
}

// ---------------- task prompts ----------------

function clearanceTask(d: Data): string {
  const probe = d.probe as ProbeResult;
  const req = d.clearance as ClearanceRequest;
  const unable = probe.ok ? "" : unablePhrase(d.callsign, req, probe);
  return probe.ok
    ? `The CIC requests a clearance for ${d.callsign} (${sp(d.callsign)}), an aircraft under your track control: "${d.phraseology}". The deterministic probe PASSED.
Task: call issue_clearance with {callsign:"${d.callsign}", kind:"${req.kind}", value:${req.value}${req.turn ? `, turn:"${req.turn}"` : ""}}. Then give your final answer: the clearance in standard phraseology (exactly "${d.phraseology}" if issued), or, if the tool refused, "Unable, ..." with the tool's reason.
Do not call send_dm or post; your final answer is delivered to the CIC for you.`
    : `The CIC requests a clearance for ${d.callsign} (${sp(d.callsign)}): "${d.phraseology}". The deterministic probe FAILED: ${probe.reasons.join(" ")}${d.alternativeText ? ` Probe-checked alternative: "${d.alternativeText}".` : " No clean alternative was found."}
Task: do NOT issue it. Your final answer is the Unable reply in standard phraseology, for example: "${unable}"
Do not call any tools; your final answer is delivered to the CIC for you.`;
}

async function boundaryTask(d: Data): Promise<string> {
  let target: number | null = null;
  try {
    const st = await aircraft(d.hex).getState();
    if (st.clearance?.kind === "altitude") target = st.clearance.value;
  } catch {
    /* no aircraft actor */
  }
  const phrase = handoffPhrase(d.callsign, d.altFt, d.vertRateFpm, target, d.distNm, d.side);
  return `RADAR: ${d.callsign} (${sp(d.callsign)}), under your track control, will cross into ${d.to} in about 90 s (${d.distNm} NM from the line, ${d.side} side, ${formatAltitude(d.altFt)}).
Task: call initiate_handoff for ${d.callsign}. If it succeeds, send_dm to ${d.to} with kind "HANDOFF", callsign "${d.callsign}", text exactly: "${phrase}". If it fails, stop.`;
}

function handoffInTask(m: RelayMessage, d: Data): string {
  const cs = (d.callsign as string) || "";
  return `${m.from} DMs you a handoff: "${m.text}" (callsign ${cs || "see text"}).
Standing CIC directions (follow them if they apply to you):
${standingDirections()}
Task: call check_handoff_entry for the aircraft. If clear and no CIC direction says otherwise: accept_handoff, then send_dm to ${m.from} kind "RADAR_CONTACT" text "${cs ? sp(cs) : "<callsign>"}, radar contact." Otherwise: reject_handoff with the reason, then send_dm to ${m.from} kind "UNABLE" with "Unable ${cs ? sp(cs) : ""}, ..." giving the traffic (from the tool) or the CIC direction, and a suggestion.`;
}

async function apreqInitTask(d: Data): Promise<string> {
  const [ac0, ac1] = d.aircraft as Data[];
  const opts = await resolutionOptions([d.a, d.b], { [d.a]: d.b, [d.b]: d.a });
  return `RADAR conflict alert ${d.id}: ${d.a} (${sp(d.a)}, your sector, ${formatAltitude(ac0!.altFt)}, ${ac0!.vertRateFpm} fpm, track ${ac0!.magTrackDeg}) and ${d.b} (${sp(d.b)}, ${other}'s sector, ${formatAltitude(ac1!.altFt)}, ${ac1!.vertRateFpm} fpm, track ${ac1!.magTrackDeg}). Predicted ${d.predictedLatNm} NM / ${d.predictedVertFt} ft in ${d.inSec} s. This is cross-sector; you control ${d.a}, so you start the APREQ.
Probe-checked resolution options:
${opts}
Task: pick ONE option (prefer maneuvering one aircraft, the simplest change). Send an APREQ to ${other}: send_dm to ${other} with kind "APREQ", conflictId "${d.id}", callsign of the aircraft to maneuver, text like "APREQ, <spoken callsign>, <clearance> for traffic <spoken other callsign>." Then update_conflict ${d.id} to "coordinating". If there are no options, update_conflict ${d.id} "escalated" and post to cic: "Unable to resolve CA ${d.a}/${d.b}, CIC action required."`;
}

async function apreqInTask(m: RelayMessage, d: Data, round: number): Promise<string> {
  const id = d.conflictId as string;
  const v = await getView();
  const c = v.conflicts.find((x) => x.id === id);
  const opts = c ? await resolutionOptions([c.a, c.b], { [c.a]: c.b, [c.b]: c.a }) : "(conflict not found)";
  const last = round >= 2;
  return `${m.from} DMs you (${d.type === "APREQ" ? "APREQ" : "Unable with a counter-proposal"}, round ${round} of 2) about conflict ${id}${c ? ` (${c.a}/${c.b}, state ${c.state})` : ""}: "${m.text}"
Recent coordination:
${relatedMessages([id, c?.a ?? "", c?.b ?? ""], m.id)}
Probe-checked options:
${opts}
Task: decide with probe_clearance if needed.
- If you approve their proposal: send_dm to ${m.from} kind "APREQ_REPLY", approved true, conflictId "${id}", text like "<spoken callsign>, <clearance readback>, approved." Then post to coord the agreed plan (one line, e.g. "Plan for CA ${c?.a ?? ""}/${c?.b ?? ""}: <spoken callsign> <clearance>. Coordinated ${me}/${m.from}.") and update_conflict ${id} "resolved" with that plan as resolution.
- ${last ? `This is the last round: if you cannot approve, update_conflict ${id} "escalated" and post to cic "CA ${c?.a ?? ""}/${c?.b ?? ""}: no agreement after two rounds. CIC action required."` : `If you cannot approve: send_dm to ${m.from} kind "APREQ_REPLY", approved false, conflictId "${id}", text "Unable, <reason>. Suggest <counter-proposal from the options>."`}`;
}

function apreqApprovedTask(m: RelayMessage, d: Data): string {
  const id = d.conflictId as string;
  return `${m.from} approved your APREQ for conflict ${id}: "${m.text}"
Task: post to coord the agreed plan in one line ("Plan for CA ...: <spoken callsign> <clearance>. Coordinated ${me}/${m.from}.") and update_conflict ${id} "resolved" with that plan as resolution. If the conflict is already resolved, do nothing.`;
}

async function sameSectorTask(d: Data): Promise<string> {
  const opts = await resolutionOptions([d.a, d.b], { [d.a]: d.b, [d.b]: d.a });
  return `RADAR conflict alert ${d.id} inside your sector: ${d.a} (${sp(d.a)}) and ${d.b} (${sp(d.b)}), predicted ${d.predictedLatNm} NM / ${d.predictedVertFt} ft in ${d.inSec} s.
Probe-checked resolution options:
${opts}
Task: pick ONE option and post it to coord as an advisory to the CIC (kind "ADVISORY"): "CA ${d.a}/${d.b}: suggest <spoken callsign>, <clearance>, for traffic <spoken other>." Then update_conflict ${d.id} "coordinating". Do not issue the clearance yourself. If there are no options, post the advisory "CA ${d.a}/${d.b}: no clean resolution found, CIC action required." and update_conflict ${d.id} "escalated".`;
}

function nonconfDmTask(m: RelayMessage, d: Data): string {
  return `MONITOR reports non-conformance for an aircraft you control: "${m.text}" (callsign ${d.callsign ?? "see text"}).
Task: post ONE short line to alerts (kind "ADVISORY") with your action, e.g. "${d.callsign ? sp(d.callsign) : "<callsign>"}: non-conformance noted, verifying altitude, traffic advisory to adjacent sector if needed." Use only numbers from the message.`;
}

function cicTask(m: RelayMessage): string {
  return `The CIC posted in #cic: "${m.text}"
Task: if this is a direction to you (${me}) or to all sectors, acknowledge it briefly with post to cic (kind "ACK"), e.g. "${me}, wilco." and follow it from now on (it stays in your standing directions). If it is a question for you, answer briefly from get_sector_picture. If it is not addressed to you, do not call any tools and answer "no action".`;
}

function monitorTask(d: Data): string {
  return `RADAR reports NONCONF: ${JSON.stringify({ callsign: d.callsign, cleared: d.clearedText, clearance: d.clearance, altFt: d.altFt, vertRateFpm: d.vertRateFpm, magTrackDeg: d.magTrackDeg, owner: d.owner, reason: d.reason })}
Task: write exactly two plain-English sentences for the CIC explaining what the aircraft was cleared to do and what it is actually doing, using only these numbers (spoken callsign: ${sp(d.callsign)}). Post them to alerts (kind "NONCONF").${d.owner ? ` Then send_dm the same text to ${d.owner} with kind "NONCONF" and callsign "${d.callsign}".` : ""}`;
}

// ---------------- worker ----------------

let busy = false;
async function work() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      const d = dataOf(job.msg);
      if (typeof d.session === "number" && d.session < session) continue;
      if (job.type !== "CLEARANCE_REQUEST" && Date.now() - job.enqueuedAt > STALE_MS) {
        console.log(`[${me}] dropped stale ${job.key}`);
        continue;
      }
      await runTurn(job);
    }
  } finally {
    busy = false;
  }
}

async function runTurn(job: Job) {
  const ctx: TurnContext = {
    me,
    relay,
    session,
    eventId: job.msg.id,
    eventType: job.type,
    ...(job.requestId ? { requestId: job.requestId } : {}),
    ...(job.conflictId ? { conflictId: job.conflictId } : {}),
    issued: null,
    probes: [],
    sent: [],
    actions: [],
  };
  turn.ctx = ctx;
  const t0 = Date.now();
  const prompt = `Event from ${job.msg.from} to ${job.msg.to}: "${job.msg.text}"
${job.task}`;
  let text = "";
  try {
    const res = await agent.generate(prompt, { maxSteps: job.type === "CLEARANCE_REQUEST" ? 3 : MAX_STEPS });
    text = (res.text || "").trim();
  } catch (e) {
    console.error(`[${me}] turn ${job.key} failed:`, (e as Error).message);
  } finally {
    turn.ctx = null;
  }
  for (const m of ctx.sent) remember(m);
  // Count our own APREQ messages toward the two-round limit.
  for (const m of ctx.sent) {
    const d = dataOf(m);
    if (d.conflictId && (d.type === "APREQ" || (d.type === "APREQ_REPLY" && d.approved === false))) {
      apreqRounds.set(d.conflictId, (apreqRounds.get(d.conflictId) ?? 0) + 1);
    }
  }

  if (job.type === "CLEARANCE_REQUEST") {
    // Guarantee a reply to the clearance workflow. `issued` comes from the tool, never from the model's words.
    const d = dataOf(job.msg);
    const issued = ctx.issued;
    const reply = issued
      ? issued.phraseology
      : text && /unable/i.test(text)
        ? text
        : unablePhrase(d.callsign, d.clearance as ClearanceRequest, d.probe as ProbeResult);
    await relay.post("cic", reply, { type: "CLEARANCE_REPLY", from: me, session, requestId: job.requestId, issued: !!issued, phraseology: issued?.phraseology ?? null, callsign: d.callsign });
  }
  console.log(`[${me}] ${job.type} ${job.key} (${Date.now() - t0} ms) actions=[${ctx.actions.join("; ")}] sent=${ctx.sent.length} ${text ? `final="${text.slice(0, 140)}"` : ""}`);
}

relay.onMessage((m) => route(m).catch((e) => console.error(`[${me}] route error:`, (e as Error).message)));
process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});
