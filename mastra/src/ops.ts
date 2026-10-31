// Deterministic operations shared by Mastra tools and the clearance workflow.
// Safety decisions (probe, issue rules) are plain code here; the LLM never decides them.
import { aircraft, airspace } from "../../shared/adapters/actors.ts";
import { clearanceWindow } from "../../shared/conformance.ts";
import { clearancePhrase } from "../../shared/phraseology.ts";
import { probeClearance } from "../../shared/probe.ts";
import type { Clearance, ClearanceRequest, ProbeResult } from "../../shared/types.ts";
import { findAircraft, getView, separationContext, toPosition, type AirspaceView } from "./view.ts";

export type ProbeOutcome =
  | { ok: true; hex: string; callsign: string; probe: ProbeResult; phraseology: string; currentAltFt: number | null }
  | { ok: false; error: string };

export async function probeFor(callsign: string, req: ClearanceRequest, view?: AirspaceView): Promise<ProbeOutcome> {
  const v = view ?? (await getView());
  if (!v.airport) return { ok: false, error: "No active airport." };
  const t = findAircraft(v, callsign);
  if (!t) return { ok: false, error: `${callsign} not in radar contact.` };
  const pos = toPosition(t);
  const probe = probeClearance(pos, req, v.positions, v.airport, separationContext(v));
  return { ok: true, hex: t.hex, callsign: t.callsign, probe, phraseology: clearancePhrase(t.callsign, req, t.altFt), currentAltFt: t.altFt };
}

export type IssueOutcome =
  | { ok: true; hex: string; callsign: string; phraseology: string; status: string; reason: string; probe: ProbeResult; override: boolean }
  | { ok: false; error: string; probe?: ProbeResult };

/**
 * Issue a clearance: probe first (always), refuse a failed probe unless this is a CIC override.
 * Creates/updates the Aircraft actor and marks the status on the Airspace actor.
 */
export async function issueClearance(input: { callsign: string; req: ClearanceRequest; issuedBy: string; override?: boolean }): Promise<IssueOutcome> {
  const v = await getView();
  if (!v.airport) return { ok: false, error: "No active airport." };
  const t = findAircraft(v, input.callsign);
  if (!t) return { ok: false, error: `${input.callsign} not in radar contact.` };
  const pos = toPosition(t);
  const probe = probeClearance(pos, input.req, v.positions, v.airport, separationContext(v));
  const override = !!input.override;
  if (!probe.ok && !override) return { ok: false, error: `Probe failed: ${probe.reasons.join(" ")}`, probe };
  const now = Date.now();
  const phraseology = clearancePhrase(t.callsign, input.req, t.altFt);
  const clearance: Clearance = {
    kind: input.req.kind,
    value: input.req.value,
    ...(input.req.turn ? { turn: input.req.turn } : {}),
    issuedAt: now,
    ...clearanceWindow(input.req.kind, now),
    issuedBy: override ? `${input.issuedBy} (CIC override)` : input.issuedBy,
    phraseology,
  };
  const r = await aircraft(t.hex).issueClearance({ clearance, callsign: t.callsign, declinationDeg: v.airport.declinationDeg, position: pos });
  await airspace().setStatus(t.hex, r.status, r.reason);
  await airspace().logClearance({
    hex: t.hex,
    callsign: t.callsign,
    kind: input.req.kind,
    value: input.req.value,
    ...(input.req.turn ? { turn: input.req.turn } : {}),
    phraseology,
    issuedBy: clearance.issuedBy,
  });
  return { ok: true, hex: t.hex, callsign: t.callsign, phraseology, status: r.status, reason: r.reason, probe, override };
}
