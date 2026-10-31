import { describe, expect, test } from "bun:test";
import type { Agreement, Candidate, ReviewFacts, SectorReview } from "../../../shared/types.ts";
import { allowedDecisions, chooseFallbackCandidate, fallbackReview, validateReview } from "./review.ts";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  kind: "altitude",
  value: 7000,
  phraseology: "United one twenty-three, climb and maintain seven thousand.",
  deviation: 1000,
  tags: ["stops_climb"],
  ...over,
});

const agreement: Agreement = {
  id: "ag1",
  hex: "a00001",
  callsign: "UAL123",
  constraint: { kind: "altitude", op: "maintain", value: 6000 },
  between: ["NORTH", "SOUTH"],
  source: "APREQ",
  text: "UAL123 maintain 6,000 (APREQ)",
  createdAt: 0,
  expiresAt: 300_000,
  state: "active",
};

const recentConflict: ReviewFacts["recentConflict"] = {
  clearance: { kind: "altitude", value: 4000, issuedAt: 0, graceUntil: 0, deadlineAt: 0, issuedBy: "CIC", phraseology: "United one twenty-three, descend and maintain four thousand." },
  secondsAgo: 30,
  why: "reverses direction (descend -> climb)",
};

const facts = (over: Partial<ReviewFacts> = {}): ReviewFacts => ({
  phase: "departure",
  probe: { ok: true, reasons: [], conflicts: [] },
  candidates: [cand("c1"), cand("c2", { kind: "heading", value: 90, turn: "right", tags: ["keeps_climb"], phraseology: "United one twenty-three, turn right heading zero niner zero." })],
  brokenAgreements: [],
  recentConflict: null,
  sectorEntry: { entersOther: false },
  directives: [],
  confirmed: false,
  ...over,
});
const failed = { ok: false, reasons: ["Traffic DAL456, 1.2 NM, 400 ft, in 40 s."], conflicts: [{ with: "DAL456", minLatNm: 1.2, minVertFt: 400, inSec: 40 }] };

const review = (over: Partial<SectorReview>): SectorReview => ({ decision: "issue", phraseology: "United one twenty-three, climb and maintain eight thousand.", reason: "Probe clean.", ...over });

describe("validateReview: issue", () => {
  test("allowed when the probe passed and nothing blocks it", () => {
    expect(validateReview(review({}), facts()).ok).toBe(true);
  });
  test("refused when the probe failed", () => {
    const r = validateReview(review({}), facts({ probe: failed }));
    expect(r.ok).toBe(false);
  });
  test("refused when it breaks an agreement, unless confirmed", () => {
    expect(validateReview(review({}), facts({ brokenAgreements: [agreement] })).ok).toBe(false);
    expect(validateReview(review({}), facts({ brokenAgreements: [agreement], confirmed: true })).ok).toBe(true);
  });
  test("refused with a recent conflicting clearance, unless confirmed", () => {
    expect(validateReview(review({}), facts({ recentConflict })).ok).toBe(false);
    expect(validateReview(review({}), facts({ recentConflict, confirmed: true })).ok).toBe(true);
  });
  test("refused when entering the other sector (needs coordinate)", () => {
    const r = validateReview(review({}), facts({ sectorEntry: { entersOther: true, inSec: 80, sector: "SOUTH" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("coordinate");
  });
});

describe("validateReview: unable", () => {
  test("requires a known candidate id when candidates exist", () => {
    expect(validateReview(review({ decision: "unable" }), facts({ probe: failed })).ok).toBe(false);
    expect(validateReview(review({ decision: "unable", chosenCandidateId: "c9" }), facts({ probe: failed })).ok).toBe(false);
    expect(validateReview(review({ decision: "unable", chosenCandidateId: "c2" }), facts({ probe: failed })).ok).toBe(true);
  });
  test("allowed without an id when there are no candidates", () => {
    expect(validateReview(review({ decision: "unable" }), facts({ probe: failed, candidates: [] })).ok).toBe(true);
  });
  test("rejects a breaks_agreement candidate when a clean one exists", () => {
    const cs = [cand("c1", { tags: ["breaks_agreement:ag1"] }), cand("c2")];
    expect(validateReview(review({ decision: "unable", chosenCandidateId: "c1" }), facts({ probe: failed, candidates: cs })).ok).toBe(false);
    expect(validateReview(review({ decision: "unable", chosenCandidateId: "c2" }), facts({ probe: failed, candidates: cs })).ok).toBe(true);
  });
  test("accepts a breaks_agreement candidate when it is the only kind", () => {
    const cs = [cand("c1", { tags: ["breaks_agreement:ag1"] })];
    expect(validateReview(review({ decision: "unable", chosenCandidateId: "c1" }), facts({ probe: failed, candidates: cs })).ok).toBe(true);
  });
});

describe("validateReview: coordinate", () => {
  const entering = { entersOther: true, inSec: 80, sector: "SOUTH" as const };
  test("allowed when entering the other sector, with a message and a clean probe", () => {
    expect(validateReview(review({ decision: "coordinate", coordinationMessage: "Point out, ..." }), facts({ sectorEntry: entering })).ok).toBe(true);
  });
  test("requires coordinationMessage", () => {
    expect(validateReview(review({ decision: "coordinate" }), facts({ sectorEntry: entering })).ok).toBe(false);
  });
  test("refused when staying in sector with no agreement involved", () => {
    expect(validateReview(review({ decision: "coordinate", coordinationMessage: "x" }), facts()).ok).toBe(false);
  });
  test("allowed when a broken agreement involves the other sector", () => {
    expect(validateReview(review({ decision: "coordinate", coordinationMessage: "x" }), facts({ brokenAgreements: [agreement] })).ok).toBe(true);
  });
  test("refused when the probe failed", () => {
    expect(validateReview(review({ decision: "coordinate", coordinationMessage: "x" }), facts({ sectorEntry: entering, probe: failed })).ok).toBe(false);
  });
});

describe("validateReview: confirm", () => {
  test("allowed with a recent conflict or a broken agreement, with a question", () => {
    expect(validateReview(review({ decision: "confirm", question: "Confirm?" }), facts({ recentConflict })).ok).toBe(true);
    expect(validateReview(review({ decision: "confirm", question: "Confirm?" }), facts({ brokenAgreements: [agreement] })).ok).toBe(true);
  });
  test("requires a question", () => {
    expect(validateReview(review({ decision: "confirm" }), facts({ recentConflict })).ok).toBe(false);
  });
  test("refused with nothing to confirm, or when already confirmed", () => {
    expect(validateReview(review({ decision: "confirm", question: "?" }), facts()).ok).toBe(false);
    expect(validateReview(review({ decision: "confirm", question: "?" }), facts({ recentConflict, confirmed: true })).ok).toBe(false);
  });
});

describe("validateReview: general", () => {
  test("unknown chosenCandidateId is refused for any decision", () => {
    expect(validateReview(review({ chosenCandidateId: "zz" }), facts()).ok).toBe(false);
  });
  test("phraseology and reason are required", () => {
    expect(validateReview(review({ phraseology: " " }), facts()).ok).toBe(false);
    expect(validateReview(review({ reason: "" }), facts()).ok).toBe(false);
  });
  test("unknown decision is refused", () => {
    expect(validateReview(review({ decision: "maybe" as never }), facts()).ok).toBe(false);
  });
});

describe("allowedDecisions", () => {
  test("clean request: issue or unable", () => {
    expect(allowedDecisions(facts())).toEqual(["issue", "unable"]);
  });
  test("entering the other sector: unable or coordinate", () => {
    expect(allowedDecisions(facts({ sectorEntry: { entersOther: true, sector: "SOUTH", inSec: 60 } }))).toEqual(["unable", "coordinate"]);
  });
  test("recent conflict: unable or confirm", () => {
    expect(allowedDecisions(facts({ recentConflict }))).toEqual(["unable", "confirm"]);
  });
});

describe("fallbackReview", () => {
  const req = "United one twenty-three, climb and maintain eight thousand.";
  test("issues when nothing blocks it", () => {
    const r = fallbackReview(facts(), req);
    expect(r.decision).toBe("issue");
    expect(r.phraseology).toBe(req);
    expect(validateReview(r, facts()).ok).toBe(true);
  });
  test("unable with the first non-breaking candidate when the probe failed", () => {
    const cs = [cand("c1", { tags: ["breaks_agreement:ag1"] }), cand("c2")];
    const f = facts({ probe: failed, candidates: cs });
    const r = fallbackReview(f, req);
    expect(r.decision).toBe("unable");
    expect(r.chosenCandidateId).toBe("c2");
    expect(r.reason).toBe("Automatic fallback: Traffic DAL456, 1.2 NM, 400 ft, in 40 s.");
    expect(r.phraseology).toContain("Suggest climb and maintain seven thousand.");
    expect(validateReview(r, f).ok).toBe(true);
  });
  test("unable for a broken agreement, recent conflict or sector entry", () => {
    expect(fallbackReview(facts({ brokenAgreements: [agreement] }), req).reason).toContain("Breaks agreement");
    expect(fallbackReview(facts({ recentConflict }), req).reason).toContain("30 s ago");
    expect(fallbackReview(facts({ sectorEntry: { entersOther: true, sector: "SOUTH", inSec: 75 } }), req).reason).toContain("Enters SOUTH in 75 s");
  });
  test("confirmed request with only a recent conflict issues", () => {
    expect(fallbackReview(facts({ recentConflict, confirmed: true }), req).decision).toBe("issue");
  });
  test("no candidates: unable without an id", () => {
    const r = fallbackReview(facts({ probe: failed, candidates: [] }), req);
    expect(r.decision).toBe("unable");
    expect(r.chosenCandidateId).toBeUndefined();
  });
});

describe("chooseFallbackCandidate", () => {
  test("first candidate without a breaks_agreement tag", () => {
    expect(chooseFallbackCandidate(facts({ candidates: [cand("c1", { tags: ["breaks_agreement:x"] }), cand("c2")] }))?.id).toBe("c2");
    expect(chooseFallbackCandidate(facts({ candidates: [cand("c1", { tags: ["breaks_agreement:x"] })] }))).toBeUndefined();
  });
});
