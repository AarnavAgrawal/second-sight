// Clearance workflow: parse -> resolve -> probe -> sectorReview -> issue (CLAUDE.md section 11a).
// Every step carries one context object; once a step decides the outcome (done), later steps pass it through.
// Safety decisions (probe, issue rule) are plain code from ops.ts and shared/; the LLM only parses.
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { clearanceBody, clearancePhrase, unablePhrase } from "../../../shared/phraseology.ts";
import { spokenCallsign } from "../../../shared/telephony.ts";
import { parseClearance } from "../agents/parser.ts";
import { issueClearance, probeFor } from "../ops.ts";
import { findAircraft, getView } from "../view.ts";

const Kind = z.enum(["altitude", "heading"]);
const Turn = z.enum(["left", "right"]);
const Req = z.object({ kind: Kind, value: z.number(), turn: Turn.optional() });
const Probe = z.object({
  ok: z.boolean(),
  reasons: z.array(z.string()),
  conflicts: z.array(z.object({ with: z.string(), minLatNm: z.number(), minVertFt: z.number(), inSec: z.number() })),
  alternative: Req.optional(),
});
const StepLog = z.object({
  id: z.enum(["parse", "resolve", "probe", "sectorReview", "issue"]),
  status: z.enum(["ok", "fail", "skipped"]),
  detail: z.string(),
  ms: z.number(),
});

/** Matches ClearanceResponse in web/src/apiTypes.ts. */
const Ctx = z.object({
  transcript: z.string(),
  override: z.boolean(),
  done: z.boolean(),
  issued: z.boolean(),
  parsed: z.object({ callsign: z.string(), kind: Kind, value: z.number(), turn: Turn.optional() }).optional(),
  hex: z.string().optional(),
  sector: z.enum(["NORTH", "SOUTH"]).optional(),
  currentAltFt: z.number().nullable().optional(),
  phraseology: z.string().optional(),
  probe: Probe.optional(),
  reason: z.string().optional(),
  alternative: z.object({ kind: Kind, value: z.number(), turn: Turn.optional(), text: z.string() }).optional(),
  sayAgain: z.boolean().optional(),
  suggestions: z.array(z.string()).optional(),
  steps: z.array(StepLog),
});
export type ClearanceResult = z.infer<typeof Ctx>;
type Step = z.infer<typeof StepLog>;

const log = (ctx: ClearanceResult, s: Step): ClearanceResult => ({ ...ctx, steps: [...ctx.steps, s] });
const skip = (ctx: ClearanceResult, id: Step["id"]): ClearanceResult => log(ctx, { id, status: "skipped", detail: "—", ms: 0 });

/** Callsigns whose spoken form shares the most words with the transcript (for "Say again"). */
function closestCallsigns(transcript: string, candidates: { callsign: string; spoken: string }[]): string[] {
  const words = new Set(transcript.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return candidates
    .map((c) => ({ c: c.callsign, score: c.spoken.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c);
}

const parse = createStep({
  id: "parse",
  inputSchema: z.object({ text: z.string(), override: z.boolean() }),
  outputSchema: Ctx,
  execute: async ({ inputData }) => {
    const t0 = Date.now();
    let ctx: ClearanceResult = { transcript: inputData.text.trim(), override: inputData.override, done: false, issued: false, steps: [] };
    const view = await getView();
    if (!view.airport) {
      return log({ ...ctx, done: true, reason: "No active airport." }, { id: "parse", status: "fail", detail: "no active airport", ms: 0 });
    }
    const candidates = view.traffic.map((t) => ({ callsign: t.callsign, spoken: spokenCallsign(t.callsign) }));
    let p;
    try {
      p = await parseClearance(ctx.transcript, candidates);
    } catch (e) {
      return log({ ...ctx, done: true, reason: `Parser unavailable: ${(e as Error).message}` }, { id: "parse", status: "fail", detail: "parser error", ms: Date.now() - t0 });
    }
    const ms = Date.now() - t0;
    if (!p.callsign || !p.kind || p.value == null) {
      const suggestions = closestCallsigns(ctx.transcript, candidates);
      ctx = { ...ctx, done: true, sayAgain: true, suggestions, reason: `Say again. ${p.problem ?? "Clearance not understood."}` };
      return log(ctx, { id: "parse", status: "fail", detail: p.problem ?? "not understood", ms });
    }
    const parsed = { callsign: p.callsign, kind: p.kind, value: p.value, ...(p.turn ? { turn: p.turn } : {}) };
    const what = p.kind === "altitude" ? `altitude ${p.value.toLocaleString("en-US")}` : `heading ${String(p.value).padStart(3, "0")}${p.turn ? ` ${p.turn}` : ""}`;
    return log({ ...ctx, parsed }, { id: "parse", status: "ok", detail: `${p.callsign} ${what}`, ms });
  },
});

const resolve = createStep({
  id: "resolve",
  inputSchema: Ctx,
  outputSchema: Ctx,
  execute: async ({ inputData: ctx }) => {
    if (ctx.done || !ctx.parsed) return skip(ctx, "resolve");
    const t0 = Date.now();
    const view = await getView();
    const t = findAircraft(view, ctx.parsed.callsign);
    if (!t) {
      return log(
        { ...ctx, done: true, sayAgain: true, suggestions: [], reason: `Say again. ${ctx.parsed.callsign} not in radar contact.` },
        { id: "resolve", status: "fail", detail: "not in radar contact", ms: Date.now() - t0 },
      );
    }
    const sector = view.trackControl[t.hex] ?? t.sector;
    return log(
      { ...ctx, hex: t.hex, sector, currentAltFt: t.altFt, parsed: { ...ctx.parsed, callsign: t.callsign } },
      { id: "resolve", status: "ok", detail: `${sector} has track control`, ms: Date.now() - t0 },
    );
  },
});

const probe = createStep({
  id: "probe",
  inputSchema: Ctx,
  outputSchema: Ctx,
  execute: async ({ inputData: ctx }) => {
    if (ctx.done || !ctx.parsed) return skip(ctx, "probe");
    const t0 = Date.now();
    const { callsign, ...req } = ctx.parsed;
    const r = await probeFor(callsign, req);
    if (!r.ok) {
      return log({ ...ctx, done: true, reason: r.error }, { id: "probe", status: "fail", detail: r.error, ms: Date.now() - t0 });
    }
    const p = r.probe;
    const next: ClearanceResult = { ...ctx, probe: p, phraseology: r.phraseology };
    if (p.ok) return log(next, { id: "probe", status: "ok", detail: "No conflicts in 120 s", ms: Date.now() - t0 });
    const alt = p.alternative;
    return log(
      {
        ...next,
        reason: unablePhrase(callsign, req, p),
        ...(alt ? { alternative: { ...alt, text: clearancePhrase(callsign, alt, r.currentAltFt) } } : {}),
      },
      { id: "probe", status: "fail", detail: p.reasons[0] ?? "Probe failed", ms: Date.now() - t0 },
    );
  },
});

// Phase 3 replaces this with a DM to the controlling sector agent over Relay (8 s timeout).
const sectorReview = createStep({
  id: "sectorReview",
  inputSchema: Ctx,
  outputSchema: Ctx,
  execute: async ({ inputData: ctx }) => {
    if (ctx.done) return skip(ctx, "sectorReview");
    return log(ctx, { id: "sectorReview", status: "skipped", detail: ctx.override ? "CIC override" : "Sector agents not running", ms: 0 });
  },
});

const issue = createStep({
  id: "issue",
  inputSchema: Ctx,
  outputSchema: Ctx,
  execute: async ({ inputData: ctx }) => {
    if (ctx.done || !ctx.parsed || !ctx.probe) return skip(ctx, "issue");
    if (!ctx.probe.ok && !ctx.override) {
      return log({ ...ctx, done: true }, { id: "issue", status: "skipped", detail: "Not issued", ms: 0 });
    }
    const t0 = Date.now();
    const { callsign, ...req } = ctx.parsed;
    const r = await issueClearance({ callsign, req, issuedBy: "CIC", override: ctx.override });
    if (!r.ok) {
      return log({ ...ctx, done: true, reason: r.error }, { id: "issue", status: "fail", detail: r.error, ms: Date.now() - t0 });
    }
    return log(
      { ...ctx, done: true, issued: true, phraseology: r.phraseology, reason: undefined, alternative: undefined },
      { id: "issue", status: "ok", detail: `Issued: ${clearanceBody(req, ctx.currentAltFt ?? null)}`, ms: Date.now() - t0 },
    );
  },
});

export const clearanceWorkflow = createWorkflow({
  id: "clearance",
  inputSchema: z.object({ text: z.string(), override: z.boolean() }),
  outputSchema: Ctx,
})
  .then(parse)
  .then(resolve)
  .then(probe)
  .then(sectorReview)
  .then(issue)
  .commit();

export async function runClearance(text: string, override = false): Promise<ClearanceResult> {
  const run = await clearanceWorkflow.createRun();
  const res = await run.start({ inputData: { text, override } });
  if (res.status !== "success") {
    const err = "error" in res && res.error ? String((res.error as Error).message ?? res.error) : res.status;
    return { transcript: text, override, done: true, issued: false, reason: `Clearance workflow ${res.status}: ${err}`, steps: [] };
  }
  return res.result as ClearanceResult;
}
