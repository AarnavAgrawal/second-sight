// Mastra tools for the sector controller and monitor agents. Thin wrappers over the actor client,
// shared/ logic, and the Relay adapter. Safety rules are enforced here in code, not by the model.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { airspace } from "../../../shared/adapters/actors.ts";
import type { Relay, RelayMessage } from "../../../shared/adapters/relay.ts";
import { haversineNm } from "../../../shared/geo.ts";
import { projectStraight } from "../../../shared/separation.ts";
import type { ProbeResult, Sector } from "../../../shared/types.ts";
import { issueClearance, probeFor } from "../ops.ts";
import { findAircraft, getView, sectorPicture, toPosition } from "../view.ts";

export type Identity = "NORTH" | "SOUTH" | "MONITOR";

/** Per-turn context set by the agent runner before each generate() call. */
export interface TurnContext {
  me: Identity;
  relay: Relay;
  session: number;
  eventId: string;
  eventType: string;
  requestId?: string;
  conflictId?: string;
  /** Set by issue_clearance when it succeeds this turn. */
  issued: { callsign: string; phraseology: string } | null;
  /** Probe results seen this turn (for the clearance reply). */
  probes: { callsign: string; probe: ProbeResult; phraseology: string }[];
  sent: RelayMessage[];
  actions: string[];
}

export const turn: { ctx: TurnContext | null } = { ctx: null };
const ctx = () => {
  if (!turn.ctx) throw new Error("No active turn.");
  return turn.ctx;
};

const SectorEnum = z.enum(["NORTH", "SOUTH"]);
const KindEnum = z.enum(["altitude", "heading"]);
const TurnEnum = z.enum(["left", "right"]);
const MsgKind = z.enum(["HANDOFF", "RADAR_CONTACT", "UNABLE", "APREQ", "APREQ_REPLY", "NONCONF", "ADVISORY", "ACK", "INFO"]);

const clearanceInput = z.object({
  callsign: z.string().describe("ICAO callsign, e.g. UAL123"),
  kind: KindEnum,
  value: z.number().int().describe("Altitude in feet (FL230 = 23000) or magnetic heading 1-360"),
  turn: TurnEnum.optional().describe("Turn direction for heading clearances"),
});

const meta = (extra: Record<string, unknown>) => {
  const c = ctx();
  return {
    from: c.me,
    session: c.session,
    inReplyTo: c.eventId,
    ...(c.requestId ? { requestId: c.requestId } : {}),
    ...(c.conflictId ? { conflictId: c.conflictId } : {}),
    ...extra,
  };
};

export const getSectorPicture = createTool({
  id: "get_sector_picture",
  description: "Active airport, aircraft under this sector's track control (altitude, vertical rate, ground speed, magnetic track, status, NM from the sector boundary), pending handoffs, and active conflict alerts.",
  inputSchema: z.object({ sector: SectorEnum.optional().describe("Defaults to your own sector") }),
  execute: async (input) => {
    const c = ctx();
    const sector = (input.sector ?? (c.me === "MONITOR" ? "NORTH" : c.me)) as Sector;
    return sectorPicture(await getView(), sector);
  },
});

export const probeClearanceTool = createTool({
  id: "probe_clearance",
  description: "Probe a proposed clearance for invalid values (simplified floor, FL450) and predicted loss of separation in the next 120 s. Returns ok, reasons, conflicts, and a safer alternative if one exists.",
  inputSchema: clearanceInput,
  execute: async (input) => {
    const r = await probeFor(input.callsign, { kind: input.kind, value: input.value, ...(input.turn ? { turn: input.turn } : {}) });
    if (!r.ok) return r;
    ctx().probes.push({ callsign: r.callsign, probe: r.probe, phraseology: r.phraseology });
    return { ok: r.probe.ok, callsign: r.callsign, phraseology: r.phraseology, reasons: r.probe.reasons, conflicts: r.probe.conflicts, alternative: r.probe.alternative ?? null };
  },
});

export const issueClearanceTool = createTool({
  id: "issue_clearance",
  description: "Issue a clearance to an aircraft you control. The clearance is probed again first; a failed probe is refused (only the CIC can override).",
  inputSchema: clearanceInput,
  execute: async (input) => {
    const c = ctx();
    const r = await issueClearance({ callsign: input.callsign, req: { kind: input.kind, value: input.value, ...(input.turn ? { turn: input.turn } : {}) }, issuedBy: c.me });
    if (!r.ok) return { ok: false, error: r.error };
    c.issued = { callsign: r.callsign, phraseology: r.phraseology };
    c.actions.push(`issued ${r.phraseology}`);
    return { ok: true, phraseology: r.phraseology, status: r.status };
  },
});

export const initiateHandoff = createTool({
  id: "initiate_handoff",
  description: "Start a handoff of an aircraft you control to the other sector. Fails if you don't have track control or a handoff is already pending.",
  inputSchema: z.object({ callsign: z.string() }),
  execute: async ({ callsign }) => {
    const c = ctx();
    if (c.me === "MONITOR") return { ok: false, error: "MONITOR has no track control." };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const to: Sector = c.me === "NORTH" ? "SOUTH" : "NORTH";
    const r = await airspace().initiateHandoff(t.hex, c.me, to);
    if (r.ok) c.actions.push(`handoff initiated ${t.callsign} to ${to}`);
    return r;
  },
});

export const checkHandoffEntry = createTool({
  id: "check_handoff_entry",
  description: "For an incoming handoff: project the aircraft 90 s ahead (entry point) and list your traffic within 3 NM and 1,000 ft of it.",
  inputSchema: z.object({ callsign: z.string() }),
  execute: async ({ callsign }) => {
    const c = ctx();
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const entry = projectStraight(toPosition(t), 90);
    const traffic = v.traffic
      .filter((o) => o.hex !== t.hex && v.trackControl[o.hex] === c.me)
      .map((o) => {
        const p = projectStraight(toPosition(o), 90);
        return {
          callsign: o.callsign,
          altFt: o.altFt,
          latNm: Math.round(haversineNm(entry.lat, entry.lon, p.lat, p.lon) * 10) / 10,
          vertFt: entry.altFt != null && p.altFt != null ? Math.round(Math.abs(entry.altFt - p.altFt) / 100) * 100 : null,
        };
      })
      .filter((o) => o.latNm < 3 && o.vertFt != null && o.vertFt < 1000);
    return { ok: true, callsign: t.callsign, entryAltFt: entry.altFt == null ? null : Math.round(entry.altFt / 100) * 100, clear: traffic.length === 0, traffic };
  },
});

export const acceptHandoff = createTool({
  id: "accept_handoff",
  description: "Accept a pending handoff to your sector. Track control transfers to you atomically.",
  inputSchema: z.object({ callsign: z.string() }),
  execute: async ({ callsign }) => {
    const c = ctx();
    if (c.me === "MONITOR") return { ok: false, error: "MONITOR has no track control." };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const r = await airspace().acceptHandoff(t.hex, c.me);
    if (r.ok) c.actions.push(`radar contact ${t.callsign}`);
    return r;
  },
});

export const rejectHandoff = createTool({
  id: "reject_handoff",
  description: "Reject a pending handoff to your sector (Unable), with the reason.",
  inputSchema: z.object({ callsign: z.string(), reason: z.string() }),
  execute: async ({ callsign, reason }) => {
    const c = ctx();
    if (c.me === "MONITOR") return { ok: false, error: "MONITOR has no track control." };
    const v = await getView();
    const t = findAircraft(v, callsign);
    if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
    const r = await airspace().rejectHandoff(t.hex, c.me, reason);
    if (r.ok) c.actions.push(`handoff unable ${t.callsign}`);
    return r;
  },
});

export const updateConflict = createTool({
  id: "update_conflict",
  description: "Update a conflict alert: coordinating (APREQ in progress), resolved (with the agreed plan as resolution), or escalated (to the CIC).",
  inputSchema: z.object({ id: z.string(), state: z.enum(["coordinating", "resolved", "escalated"]), resolution: z.string().optional() }),
  execute: async ({ id, state, resolution }) => {
    const r = await airspace().updateConflict(id, { state, ...(resolution ? { resolution } : {}) });
    if (r.ok) ctx().actions.push(`conflict ${id} ${state}`);
    return r;
  },
});

export const sendDm = createTool({
  id: "send_dm",
  description: "Send a direct message over Agent Relay to another controller (NORTH, SOUTH, MONITOR) or the CIC. Use standard phraseology.",
  inputSchema: z.object({
    to: z.enum(["NORTH", "SOUTH", "MONITOR", "CIC"]),
    text: z.string(),
    kind: MsgKind.optional(),
    callsign: z.string().optional(),
    conflictId: z.string().optional(),
    approved: z.boolean().optional().describe("For APREQ_REPLY: true = approved, false = unable/counter-proposal"),
  }),
  execute: async (input) => {
    const c = ctx();
    if (input.to === c.me) return { ok: false, error: "Cannot DM yourself." };
    const m = await c.relay.dm(
      input.to,
      input.text,
      meta({ type: input.kind ?? "INFO", ...(input.callsign ? { callsign: input.callsign } : {}), ...(input.conflictId ? { conflictId: input.conflictId } : {}), ...(input.approved !== undefined ? { approved: input.approved } : {}) }),
    );
    c.sent.push(m);
    return { ok: true, id: m.id };
  },
});

export const postTool = createTool({
  id: "post",
  description: "Post a message to an Agent Relay channel: coord (coordination plans, advisories), alerts (conformance), cic (to the Controller-in-Charge).",
  inputSchema: z.object({ channel: z.enum(["coord", "alerts", "cic"]), text: z.string(), kind: MsgKind.optional() }),
  execute: async (input) => {
    const c = ctx();
    const m = await c.relay.post(input.channel, input.text, meta({ type: input.kind ?? "INFO" }));
    c.sent.push(m);
    return { ok: true, id: m.id };
  },
});

export const sectorTools = {
  get_sector_picture: getSectorPicture,
  probe_clearance: probeClearanceTool,
  issue_clearance: issueClearanceTool,
  initiate_handoff: initiateHandoff,
  check_handoff_entry: checkHandoffEntry,
  accept_handoff: acceptHandoff,
  reject_handoff: rejectHandoff,
  update_conflict: updateConflict,
  send_dm: sendDm,
  post: postTool,
};

export const monitorTools = {
  get_sector_picture: getSectorPicture,
  send_dm: sendDm,
  post: postTool,
};
