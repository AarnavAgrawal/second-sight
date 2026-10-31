// Sector review validation and deterministic fallback (docs/ai-protocol.md "Validation" and "Fallback").
// Pure functions, no IO: used by the submit_review tool (agents) and the clearance workflow (bridge).
// The AI picks a decision and a candidate id; these rules decide whether that pick is allowed.
import type { Candidate, ReviewDecision, ReviewFacts, SectorReview } from "../../../shared/types.ts";

export type ReviewCheck = { ok: true } | { ok: false; error: string };

const BREAKS = "breaks_agreement:";
const breaksAgreement = (c: Candidate) => c.tags.some((t) => t.startsWith(BREAKS));
const blank = (s: string | undefined) => !s || !s.trim();

/** A broken agreement "involves the other sector" when it is shared with a sector besides the owner. */
function agreementInvolvesOther(facts: ReviewFacts): boolean {
  return facts.brokenAgreements.some((a) => a.between.length > 1 || (!!facts.sectorEntry.sector && a.between.includes(facts.sectorEntry.sector)));
}

/** Effective facts after a CIC confirm: the recent conflict is acknowledged and broken agreements count as cancelled. */
function openIssues(facts: ReviewFacts) {
  return {
    broken: facts.confirmed ? 0 : facts.brokenAgreements.length,
    recent: facts.confirmed ? null : facts.recentConflict,
  };
}

/** Validate a sector review against the facts packet. Same rules in the tool and the workflow. */
export function validateReview(review: SectorReview, facts: ReviewFacts): ReviewCheck {
  if (!review || typeof review !== "object") return { ok: false, error: "Missing review." };
  if (blank(review.phraseology)) return { ok: false, error: "phraseology is required." };
  if (blank(review.reason)) return { ok: false, error: "reason is required: name the deciding facts." };

  let chosen: Candidate | undefined;
  if (review.chosenCandidateId !== undefined) {
    chosen = facts.candidates.find((c) => c.id === review.chosenCandidateId);
    if (!chosen) {
      const ids = facts.candidates.map((c) => c.id).join(", ") || "none";
      return { ok: false, error: `Unknown candidate id "${review.chosenCandidateId}". Known ids: ${ids}.` };
    }
  }
  const { broken, recent } = openIssues(facts);

  switch (review.decision) {
    case "issue": {
      if (!facts.probe.ok) return { ok: false, error: `Cannot issue: the requested clearance failed the probe (${facts.probe.reasons.join(" ")}).` };
      if (broken > 0) return { ok: false, error: `Cannot issue: it breaks an agreement (${facts.brokenAgreements.map((a) => a.text).join("; ")}). Use unable or confirm.` };
      if (recent) return { ok: false, error: `Cannot issue: it conflicts with a recent clearance (${recent.why}). Use confirm or unable.` };
      if (facts.sectorEntry.entersOther) return { ok: false, error: `Cannot issue directly: it enters ${facts.sectorEntry.sector ?? "the other sector"} within 120 s. Use coordinate with a point out.` };
      return { ok: true };
    }
    case "unable": {
      if (facts.candidates.length > 0) {
        if (!chosen) return { ok: false, error: `unable requires chosenCandidateId (one of: ${facts.candidates.map((c) => c.id).join(", ")}).` };
        if (breaksAgreement(chosen) && facts.candidates.some((c) => !breaksAgreement(c))) {
          return { ok: false, error: `Candidate ${chosen.id} breaks an agreement while candidates without that tag exist. Pick one of: ${facts.candidates.filter((c) => !breaksAgreement(c)).map((c) => c.id).join(", ")}.` };
        }
      }
      return { ok: true };
    }
    case "coordinate": {
      if (!facts.sectorEntry.entersOther && !agreementInvolvesOther(facts)) {
        return { ok: false, error: "coordinate is only allowed when the aircraft enters the other sector within 120 s or a broken agreement involves the other sector." };
      }
      if (!facts.probe.ok) return { ok: false, error: `Cannot coordinate: the requested clearance failed the probe (${facts.probe.reasons.join(" ")}). Use unable.` };
      if (blank(review.coordinationMessage)) return { ok: false, error: "coordinate requires coordinationMessage (the point out text)." };
      return { ok: true };
    }
    case "confirm": {
      if (facts.confirmed) return { ok: false, error: "The CIC already confirmed this request; decide issue, coordinate or unable." };
      if (!facts.recentConflict && facts.brokenAgreements.length === 0) {
        return { ok: false, error: "confirm is only allowed when there is a recent conflicting clearance or a broken agreement." };
      }
      if (blank(review.question)) return { ok: false, error: "confirm requires question." };
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown decision "${String((review as { decision?: unknown }).decision)}".` };
  }
}

/** Decisions the rules allow for these facts (shown to the agent; actual submissions are still validated). */
export function allowedDecisions(facts: ReviewFacts): ReviewDecision[] {
  const probe = (d: ReviewDecision): SectorReview => ({
    decision: d,
    phraseology: "x",
    reason: "x",
    question: "x",
    coordinationMessage: "x",
    ...(d === "unable" && facts.candidates.length ? { chosenCandidateId: (chooseFallbackCandidate(facts) ?? facts.candidates[0]!).id } : {}),
  });
  return (["issue", "unable", "confirm", "coordinate"] as ReviewDecision[]).filter((d) => validateReview(probe(d), facts).ok);
}

/** The first candidate (generator order = smallest deviation) without a breaks_agreement tag. */
export function chooseFallbackCandidate(facts: ReviewFacts): Candidate | undefined {
  return facts.candidates.find((c) => !breaksAgreement(c));
}

/** "United one twenty-three, climb and maintain seven thousand." -> "climb and maintain seven thousand" */
function bodyOf(phraseology: string): string {
  const s = phraseology.trim().replace(/\.$/, "");
  const i = s.indexOf(", ");
  return i >= 0 ? s.slice(i + 2) : s;
}

/** The fact that blocks a plain issue, in plain words (null when nothing blocks it). */
function decidingFact(facts: ReviewFacts): string | null {
  const { broken, recent } = openIssues(facts);
  if (!facts.probe.ok) return facts.probe.reasons.join(" ") || "Probe failed.";
  if (broken > 0) return `Breaks agreement: ${facts.brokenAgreements.map((a) => a.text).join("; ")}.`;
  if (recent) return `Conflicts with a clearance issued ${Math.round(recent.secondsAgo)} s ago (${recent.why}).`;
  if (facts.sectorEntry.entersOther) {
    return `Enters ${facts.sectorEntry.sector ?? "the other sector"}${facts.sectorEntry.inSec != null ? ` in ${Math.round(facts.sectorEntry.inSec)} s` : ""} without coordination.`;
  }
  return null;
}

/**
 * Deterministic review used when the agent times out or submits nothing valid (docs/ai-protocol.md "Fallback").
 * Issue if nothing blocks it; otherwise unable with the first candidate lacking a breaks_agreement tag.
 * A CIC confirm (facts.confirmed) clears the recent-conflict and broken-agreement blocks, as in validateReview.
 */
export function fallbackReview(facts: ReviewFacts, requestedPhraseology: string): SectorReview {
  const fact = decidingFact(facts);
  if (fact == null) {
    return { decision: "issue", phraseology: requestedPhraseology, reason: "Automatic fallback: probe clean, no agreement or recent-clearance issue, stays in sector." };
  }
  const cand = chooseFallbackCandidate(facts);
  const req = requestedPhraseology.trim().replace(/\.$/, "");
  const phraseology = `Unable, ${req}. ${fact}${cand ? ` Suggest ${bodyOf(cand.phraseology)}.` : ""}`;
  return {
    decision: "unable",
    ...(cand ? { chosenCandidateId: cand.id } : {}),
    phraseology,
    reason: `Automatic fallback: ${fact}`,
  };
}
