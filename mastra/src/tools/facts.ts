// Deterministic facts for agent turns: candidate bookkeeping (ids the agent may pick), candidate generation
// over the live view, and point-out / handoff pre-checks. Plain code; the agent only reads the results.
import { generateCandidates } from "../../../shared/candidates.ts";
import { flightPhase } from "../../../shared/phase.ts";
import { projectClearedPath } from "../../../shared/probe.ts";
import { firstLoss, straightPath } from "../../../shared/separation.ts";
import type { Candidate, CandidateGoal, ClearanceRequest, Directive, FlightPhase, Sector, TrafficEntry } from "../../../shared/types.ts";
import { liveAgreements, liveDirectives, toPosition, type AirspaceView } from "../view.ts";

/** A candidate plus the aircraft it belongs to (candidate ids "c1.." repeat across aircraft). */
export type CandidateRef = Candidate & { callsign: string; hex: string };
export type CandidateMap = Map<string, CandidateRef>;

const sameClearance = (a: Candidate, b: Candidate) => a.kind === b.kind && a.value === b.value && (a.turn ?? null) === (b.turn ?? null);
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Store a candidate under `key`; if the key is taken by a different clearance, use `key-2`, `key-3`, ... Returns the key used. */
export function putCandidate(map: CandidateMap, key: string, c: CandidateRef): string {
  let k = key;
  for (let i = 2; ; i++) {
    const existing = map.get(k);
    if (!existing || (existing.hex === c.hex && sameClearance(existing, c))) {
      if (!existing) map.set(k, c);
      return k;
    }
    k = `${key}-${i}`;
  }
}

/** Look up a candidate by key ("c1" for review candidates, "UAL123:c1" otherwise); either form is accepted. */
export function findCandidate(map: CandidateMap, id: string | undefined | null): { ok: true; key: string; candidate: CandidateRef } | { ok: false; error: string } {
  const known = () => [...map.keys()].join(", ") || "none";
  if (!id) return { ok: false, error: `Missing candidate id. Known ids: ${known()}.` };
  const direct = map.get(id);
  if (direct) return { ok: true, key: id, candidate: direct };
  const colon = id.lastIndexOf(":");
  if (colon > 0) {
    const cs = norm(id.slice(0, colon));
    const cid = id.slice(colon + 1);
    for (const [k, c] of map) if (c.id === cid && norm(c.callsign) === cs) return { ok: true, key: k, candidate: c };
  } else {
    const hits = [...map.entries()].filter(([, c]) => c.id === id);
    if (hits.length === 1) return { ok: true, key: hits[0]![0], candidate: hits[0]![1] };
    if (hits.length > 1) return { ok: false, error: `Candidate id "${id}" is ambiguous; use one of: ${hits.map(([k]) => k).join(", ")}.` };
  }
  return { ok: false, error: `Unknown candidate id "${id}". Known ids: ${known()}. Never invent a candidate.` };
}

/** Math-generated, probe-clean candidates for one aircraft over the live view. */
export function candidatesFor(
  view: AirspaceView,
  t: TrafficEntry,
  goal: CandidateGoal,
  requested: ClearanceRequest | null,
  opts: { owner?: Sector; max?: number } = {},
): CandidateRef[] {
  if (!view.airport) return [];
  const owner = opts.owner ?? view.trackControl[t.hex];
  const list = generateCandidates(toPosition(t), requested, view.positions, view.airport, {
    goal,
    agreements: liveAgreements(view),
    ...(owner ? { owner } : {}),
    now: Date.now(),
    ...(opts.max ? { max: opts.max } : {}),
  });
  return list.map((c) => ({ ...c, callsign: t.callsign, hex: t.hex }));
}

/** Add candidates to the map keyed `${callsign}:${id}`; returns them with the keys actually used. */
export function seedCandidates(map: CandidateMap, list: CandidateRef[]): { key: string; c: CandidateRef }[] {
  return list.map((c) => ({ key: putCandidate(map, `${c.callsign}:${c.id}`, c), c }));
}

/** One prompt line per candidate: id, phraseology, deviation, tags. */
export function candidateLine(key: string, c: Candidate): string {
  const unit = c.kind === "altitude" ? "ft" : "deg";
  return `- ${key}: "${c.phraseology}" (deviation ${Math.round(c.deviation)} ${unit}; tags: ${c.tags.length ? c.tags.join(", ") : "none"})`;
}

export function phaseOf(view: AirspaceView, t: TrafficEntry): FlightPhase | null {
  return view.airport ? flightPhase(toPosition(t), view.airport) : null;
}

/** Active `no_handoffs` directives addressed to this sector (or ALL). */
export function handoffBlocks(view: AirspaceView, me: Sector): Directive[] {
  return liveDirectives(view, me).filter((d) => d.rule?.type === "no_handoffs");
}

export interface PointOutCheck {
  clear: boolean;
  /** My aircraft that would come within 3 NM and 1,000 ft of the requester's cleared path in 120 s. */
  traffic: { callsign: string; minLatNm: number; minVertFt: number; inSec: number }[];
  /** Directives that forbid this point out (altitude cap / floor violated by the requested altitude). */
  blocking: string[];
  /** All active directives for me (context for the agent). */
  directives: string[];
}

/** Receiving-side pre-check for a point out: traffic along the requester's cleared path, and directives. */
export function pointOutPrecheck(view: AirspaceView, me: Sector, hex: string, req: ClearanceRequest | null): PointOutCheck {
  const directives = liveDirectives(view, me);
  const t = view.traffic.find((x) => x.hex === hex);
  const traffic: PointOutCheck["traffic"] = [];
  if (t && view.airport) {
    const p = toPosition(t);
    const path = req ? projectClearedPath(p, req, view.airport.declinationDeg) : straightPath(p);
    for (const o of view.traffic) {
      if (o.hex === hex || o.altFt == null || view.trackControl[o.hex] !== me) continue;
      const loss = firstLoss(path, straightPath(toPosition(o)));
      if (loss) traffic.push({ callsign: o.callsign, minLatNm: Math.round(loss.minLatNm * 10) / 10, minVertFt: Math.round(loss.minVertFt / 100) * 100, inSec: loss.inSec });
    }
  }
  const blocking: string[] = [];
  if (req?.kind === "altitude") {
    for (const d of directives) {
      const v = d.rule?.value;
      if (v == null) continue;
      if (d.rule?.type === "altitude_cap" && req.value > v) blocking.push(`CIC directive "${d.text}" (altitude cap ${v} ft)`);
      if (d.rule?.type === "altitude_floor" && req.value < v) blocking.push(`CIC directive "${d.text}" (altitude floor ${v} ft)`);
    }
  }
  traffic.sort((a, b) => a.inSec - b.inSec);
  return { clear: traffic.length === 0 && blocking.length === 0, traffic, blocking, directives: directives.map((d) => `${d.target}: "${d.text}"${d.rule ? ` [${d.rule.type}${d.rule.value != null ? ` ${d.rule.value}` : ""}]` : ""}`) };
}
