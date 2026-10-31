// Clearance workflow (CLAUDE.md 11a): parse -> resolve -> probe -> sectorReview -> result.
// Every clearance, voice or typed, runs through here. Each step has Zod input/output schemas.
// Once a step produces a final answer (say again, unable, issued), later steps pass it through.
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { airspace } from "../../../shared/adapters/actors.ts";
import type { Relay } from "../../../shared/adapters/relay.ts";
import { clearancePhrase, unablePhrase } from "../../../shared/phraseology.ts";
import { probeClearance } from "../../../shared/probe.ts";
import { spokenCallsign } from "../../../shared/telephony.ts";
import type { ClearanceRequest, ProbeResult } from "../../../shared/types.ts";
import { parseClearance } from "../agents/parser.ts";
import { issueClearance } from "../ops.ts";
import { findAircraft, getView, toPosition } from "../view.ts";

// ---- dependencies injected by the bridge ----
const deps: { relay: Relay | null; reviewTimeoutMs: number; mode: "agents" | "direct" } = {
  relay: null,
  reviewTimeoutMs: Number(process.env.SECTOR_REVIEW_TIMEOUT_MS || 8000),
  mode: (process.env.CLEARANCE_MODE || "agents") === "direct" ? "direct" : "agents",
};
export function configureClearanceWorkflow(d: { relay: Relay | null }) {
  deps.relay = d.relay;
}

// ---- schemas ----
const StepId = z.enum(["parse", "resolve", "probe", "sectorReview", "issue"]);
const StepLog = z.object({ id: StepId, status: z.enum(["ok", "fail", "skipped"]), detail: z.string(), ms: z.number() });
const Sector = z.enum(["NORTH", "SOUTH"]);
const Parsed = z.object({ callsign: z.string(), kind: z.enum(["altitude", "heading"]), value: z.number(), turn: z.enum(["left", "right"]).optional() });
const Alternative = z.object({ kind: z.enum(["altitude", "heading"]), value: z.number(), turn: z.enum(["left", "right"]).optional(), text: z.string() });

export const ClearanceResultSchema = z.object({
  issued: z.boolean(),
  transcript: z.string(),
  parsed: Parsed.optional(),
  hex: z.string().optional(),
  sector: Sector.optional(),
  phraseology: z.string().optional(),
  probe: z.any().optional(),
  reason: z.string().optional(),
  alternative: Alternative.optional(),
  sayAgain: z.boolean().optional(),
  suggestions: z.array(z.string()).optional(),
  override: z.boolean().optional(),
  steps: z.array(StepLog),
});
export type ClearanceResult = z.infer<typeof ClearanceResultSchema>;

const Flow = z.object({
  text: z.string(),
  override: z.boolean(),
  parsed: Parsed.nullable(),
  hex: z.string().nullable(),
  callsign: z.string().nullable(),
  sector: Sector.nullable(),
  currentAltFt: z.number().nullable(),
  phraseology: z.string().nullable(),
  probe: z.any().nullable(),
  steps: z.array(StepLog),
  final: ClearanceResultSchema.nullable(),
});
type Flow = z.infer<typeof Flow>;

export const ClearanceInputSchema = z.object({ text: z.string(), override: z.boolean().optional(), selectedHex: z.string().nullable().optional() });

const log = (f: Flow, id: z.infer<typeof StepId>, status: "ok" | "fail" | "skipped", detail: string, t0: number): Flow => ({
  ...f,
  steps: [...f.steps, { id, status, detail, ms: Date.now() - t0 }],
});
const finish = (f: Flow, extra: Partial<ClearanceResult> & { issued: boolean }): Flow => ({
  ...f,
  final: {
    transcript: f.text,
    ...(f.parsed ? { parsed: f.parsed } : {}),
    ...(f.hex ? { hex: f.hex } : {}),
    ...(f.sector ? { sector: f.sector } : {}),
    ...(f.phraseology ? { phraseology: f.phraseology } : {}),
    ...(f.probe ? { probe: f.probe } : {}),
    ...(f.override ? { override: true } : {}),
    steps: f.steps,
    ...extra,
  },
});
const toReq = (p: z.infer<typeof Parsed>): ClearanceRequest => ({ kind: p.kind, value: p.value, ...(p.turn ? { turn: p.turn } : {}) });

// ---- steps ----
const parseStep = createStep({
  id: "parse",
  description: "Clearance parser agent turns the CIC transmission into { callsign, kind, value, turn }.",
  inputSchema: ClearanceInputSchema,
  outputSchema: Flow,
  execute: async ({ inputData }) => {
    const t0 = Date.now();
    let f: Flow = {
      text: inputData.text.trim(),
      override: !!inputData.override,
      parsed: null,
      hex: null,
      callsign: null,
      sector: null,
      currentAltFt: null,
      phraseology: null,
      probe: null,
      steps: [],
      final: null,
    };
    const v = await getView();
    if (!v.airport) return finish(log(f, "parse", "fail", "No active airport.", t0), { issued: false, reason: "No active airport.", sayAgain: true });
    // Selected aircraft first so the parser prefers it on ambiguity.
    const sel = inputData.selectedHex ? v.traffic.filter((t) => t.hex === inputData.selectedHex) : [];
    const cands = [...sel, ...v.traffic.filter((t) => t.hex !== inputData.selectedHex)].map((t) => ({ callsign: t.callsign, spoken: spokenCallsign(t.callsign) }));
    try {
      const p = await parseClearance(f.text, cands);
      if (!p.callsign || !p.kind || p.value == null) {
        const words = f.text.toLowerCase();
        const suggestions = cands.filter((c) => c.spoken.toLowerCase().split(" ").some((w) => w.length > 3 && words.includes(w))).slice(0, 5).map((c) => c.callsign);
        f = log(f, "parse", "fail", p.problem ?? "Could not parse a clearance.", t0);
        return finish(f, { issued: false, reason: `Say again. ${p.problem ?? ""}`.trim(), sayAgain: true, suggestions });
      }
      f.parsed = { callsign: p.callsign, kind: p.kind, value: p.value, ...(p.turn ? { turn: p.turn } : {}) };
      return log(f, "parse", "ok", `${p.callsign} ${p.kind} ${p.value}${p.turn ? ` ${p.turn}` : ""}`, t0);
    } catch (e) {
      f = log(f, "parse", "fail", `Parser error: ${(e as Error).message}`, t0);
      return finish(f, { issued: false, reason: "Say again. The clearance parser is unavailable.", sayAgain: true });
    }
  },
});

const resolveStep = createStep({
  id: "resolve",
  description: "Match the callsign against Airspace.traffic and look up track control.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed) return f;
    const t0 = Date.now();
    const v = await getView();
    const t = findAircraft(v, f.parsed.callsign);
    if (!t) {
      const g = log(f, "resolve", "fail", `${f.parsed.callsign} not in radar contact.`, t0);
      return finish(g, { issued: false, reason: `Say again. ${f.parsed.callsign} not in radar contact.`, sayAgain: true });
    }
    const sector = v.trackControl[t.hex] ?? (v.airport && t.lat >= v.airport.lat ? "NORTH" : "SOUTH");
    const g: Flow = { ...f, hex: t.hex, callsign: t.callsign, sector, currentAltFt: t.altFt, phraseology: clearancePhrase(t.callsign, toReq(f.parsed), t.altFt) };
    return log(g, "resolve", "ok", `${t.callsign} (${t.hex}) owned by ${sector}`, t0);
  },
});

const probeStep = createStep({
  id: "probe",
  description: "Run probeClearance from shared/ (plain code) on fresh traffic.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex) return f;
    const t0 = Date.now();
    const v = await getView();
    const t = v.traffic.find((x) => x.hex === f.hex);
    if (!v.airport || !t) return finish(log(f, "probe", "fail", "Aircraft lost.", t0), { issued: false, reason: "Unable. Radar contact lost." });
    const probe = probeClearance(toPosition(t), toReq(f.parsed), v.positions, v.airport);
    const g = { ...f, probe };
    return log(g, "probe", probe.ok ? "ok" : "fail", probe.ok ? "No conflicts. Valid." : probe.reasons.join(" "), t0);
  },
});

function alternativeOf(f: Flow): z.infer<typeof Alternative> | undefined {
  const alt = (f.probe as ProbeResult | null)?.alternative;
  if (!alt || !f.callsign) return undefined;
  return { kind: alt.kind, value: alt.value, ...(alt.turn ? { turn: alt.turn } : {}), text: clearancePhrase(f.callsign, alt, f.currentAltFt) };
}

const sectorReviewStep = createStep({
  id: "sectorReview",
  description: "DM the owning sector controller agent over Relay with the parsed clearance and probe result; wait up to 8 s for it to issue or reply Unable. CIC override skips review and issues directly.",
  inputSchema: Flow,
  outputSchema: Flow,
  execute: async ({ inputData: f }) => {
    if (f.final || !f.parsed || !f.hex || !f.callsign || !f.sector) return f;
    const t0 = Date.now();
    const req = toReq(f.parsed);
    const probe = f.probe as ProbeResult;

    if (f.override) {
      const r = await issueClearance({ callsign: f.callsign, req, issuedBy: "CIC", override: true });
      const g = log(f, "sectorReview", "skipped", "CIC override: sector review skipped.", t0);
      if (!r.ok) return finish(g, { issued: false, reason: r.error });
      const warn = probe.ok ? "Probe clean." : `Probe warnings: ${probe.reasons.join(" ")}`;
      const text = `CIC override: ${r.phraseology} ${warn}`;
      await airspace().addAlert({ ts: Date.now(), kind: "OVERRIDE", text });
      if (deps.relay) await deps.relay.post("cic", text, { type: "OVERRIDE", hex: f.hex, callsign: f.callsign, clearance: req, probe }).catch(() => {});
      return finish(log(g, "issue", "ok", r.phraseology, t0), { issued: true, phraseology: r.phraseology });
    }

    if (deps.mode === "direct" || !deps.relay) {
      // No sector agents available: the probe alone decides (Phase 2 behavior).
      const g = log(f, "sectorReview", "skipped", deps.relay ? "Direct mode." : "Relay offline; probe decided.", t0);
      if (!probe.ok) return finish(g, { issued: false, reason: unablePhrase(f.callsign, req, probe), alternative: alternativeOf(f) });
      const r = await issueClearance({ callsign: f.callsign, req, issuedBy: f.sector });
      if (!r.ok) return finish(g, { issued: false, reason: r.error, alternative: alternativeOf(f) });
      return finish(log(g, "issue", "ok", r.phraseology, t0), { issued: true, phraseology: r.phraseology });
    }

    const relay = deps.relay;
    const requestId = `CLR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const reply = relay.waitFor((m) => m.from === f.sector && (m.data as { requestId?: string } | null)?.requestId === requestId, deps.reviewTimeoutMs);
    const summary = probe.ok ? "Probe: clean." : `Probe: FAILED. ${probe.reasons.join(" ")}`;
    await relay.dm(f.sector, `Clearance request from CIC: ${f.phraseology} ${summary}`, {
      type: "CLEARANCE_REQUEST",
      requestId,
      hex: f.hex,
      callsign: f.callsign,
      clearance: req,
      phraseology: f.phraseology,
      currentAltFt: f.currentAltFt,
      probe,
      alternativeText: alternativeOf(f)?.text ?? null,
    });
    const m = await reply;
    if (!m) {
      const g = log(f, "sectorReview", "fail", `No response from ${f.sector} in ${Math.round(deps.reviewTimeoutMs / 1000)} s.`, t0);
      return finish(g, { issued: false, reason: `No response from sector ${f.sector}. CIC decides.`, alternative: alternativeOf(f) });
    }
    const d = (m.data ?? {}) as { issued?: boolean; phraseology?: string };
    if (d.issued) {
      const g = log(f, "sectorReview", "ok", `${f.sector}: ${m.text}`, t0);
      return finish(log(g, "issue", "ok", d.phraseology ?? f.phraseology ?? "", t0), { issued: true, phraseology: d.phraseology ?? f.phraseology ?? undefined });
    }
    const g = log(f, "sectorReview", "fail", `${f.sector}: ${m.text}`, t0);
    return finish(g, { issued: false, reason: m.text, alternative: alternativeOf(f) });
  },
});

const resultStep = createStep({
  id: "result",
  description: "Return { issued, phraseology } or { issued: false, reason, alternative }.",
  inputSchema: Flow,
  outputSchema: ClearanceResultSchema,
  execute: async ({ inputData: f }) => f.final ?? { issued: false, transcript: f.text, reason: "Say again.", sayAgain: true, steps: f.steps },
});

export const clearanceWorkflow = createWorkflow({
  id: "clearance",
  description: "CIC clearance: parse, resolve, probe, sector review, result.",
  inputSchema: ClearanceInputSchema,
  outputSchema: ClearanceResultSchema,
})
  .then(parseStep)
  .then(resolveStep)
  .then(probeStep)
  .then(sectorReviewStep)
  .then(resultStep)
  .commit();

export async function runClearance(input: z.infer<typeof ClearanceInputSchema>): Promise<ClearanceResult> {
  const run = await clearanceWorkflow.createRun();
  const res = await run.start({ inputData: input });
  if (res.status === "success") return res.result as ClearanceResult;
  const err = res.status === "failed" ? String((res as { error?: unknown }).error ?? "workflow failed") : res.status;
  return { issued: false, transcript: input.text, reason: `Clearance workflow ${err}.`, steps: [] };
}
