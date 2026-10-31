// Shared data model for Second Sight (CLAUDE.md section 7).
// Pure types only; safe to import from bridge, agents, actor, and web.

export type Sector = "NORTH" | "SOUTH";
export const SECTORS: readonly Sector[] = ["NORTH", "SOUTH"] as const;
export const otherSector = (s: Sector): Sector => (s === "NORTH" ? "SOUTH" : "NORTH");

export interface Airport {
  icao: string;
  name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  elevationFt: number;
  radiusNm: number;
  /** East-positive magnetic declination in degrees, computed once on configure. */
  declinationDeg: number;
}

export interface Position {
  hex: string;
  callsign: string;
  registration: string | null;
  typeCode: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number;
  trackTrueDeg: number;
  vertRateFpm: number;
  seenSec: number;
  /** Epoch ms when this position was observed. */
  ts: number;
  /** Mode A code from the ADS-B `squawk` field, or null when the feed has none (TIS-B etc.). */
  squawk?: string | null;
  /** Squawking 1200 (VFR). normalizeAdsb always sets it; optional so older data and fixtures still type-check. */
  isVfr?: boolean;
}

export type ClearanceKind = "altitude" | "heading";
export type Turn = "left" | "right";

export interface ClearanceRequest {
  kind: ClearanceKind;
  value: number;
  turn?: Turn;
}

export interface Clearance extends ClearanceRequest {
  issuedAt: number;
  graceUntil: number;
  deadlineAt: number;
  issuedBy: string;
  phraseology: string;
}

export interface ProbeConflict {
  with: string;
  /** ICAO hex of the conflicting traffic. */
  withHex?: string;
  minLatNm: number;
  minVertFt: number;
  inSec: number;
  /** Separation rule that applied to the pair (shared/separation.ts pairRule). Absent = standard. */
  basis?: SeparationBasis;
}

// ---------- Separation rules (shared/separation.ts, thresholds in SEPARATION) ----------

/**
 * Which separation rule applied to a pair (shared/separation.ts pairRule):
 * - standard: 3 NM / 1,000 ft terminal radar separation (FAA JO 7110.65 5-5-4, 4-5-1).
 * - high_altitude: both at or above 18,000 ft: 5 NM / 1,000 ft (5-5-4, the en route radar minimum).
 * - vfr_mixed: one VFR (1200), one IFR: Class B VFR minima 1.5 NM / 500 ft (7-9-4).
 * - vfr_pair: both VFR: never a conflict alert, only a traffic advisory (7-9-4: light VFR aircraft need only
 *   target resolution from each other; traffic information per 2-1-21).
 * - final_suppressed: both established inbound on final (near, low, descending, closing): no conflict
 *   (simplified: parallel and in-trail finals are separated by approach procedures and visual separation,
 *   5-9, 7-4-4, not by the 3 NM radar minimum).
 * - visual: visual separation (7-2-1), from what was heard on the frequency (evaluation only).
 */
export type SeparationBasis = "standard" | "high_altitude" | "vfr_mixed" | "vfr_pair" | "final_suppressed" | "visual";

/** Clearances an aircraft is currently flying (latest per kind), used to project it instead of a straight line. */
export type Intent = { altitude?: ClearanceRequest; heading?: ClearanceRequest };

export interface SeparationContext {
  /** Aircraft (hex) with visual separation: pilot has the traffic in sight or was told to maintain visual separation. */
  visualHex?: Set<string>;
  /** Clearances in progress, keyed by hex (shared/projection.ts intentsFromLog). */
  intents?: Map<string, Intent>;
}

export interface ProbeResult {
  ok: boolean;
  reasons: string[];
  conflicts: ProbeConflict[];
  alternative?: ClearanceRequest;
  /** ai-updates.md 10: all math-validated candidates (the AI picks one as `alternative`). */
  alternatives?: Candidate[];
}

// ---------------- ai-updates.md: candidates, phase, agreements, directives, reviews ----------------

/**
 * A safe option generated and probed by shared/ code (ai-updates.md 3a). Agents choose candidates by `id`;
 * they never supply their own numbers.
 */
export interface Candidate {
  id: string; // "c1", "c2", ...
  kind: ClearanceKind;
  value: number;
  turn?: Turn;
  phraseology: string;
  /** Distance from the requested clearance (ft for altitude, degrees for heading). */
  deviation: number;
  /** Computed facts: keeps_climb | stops_climb | keeps_descent | stops_descent | enters_other_sector_120s |
   *  breaks_agreement:<id> | toward_airport | away_from_airport | large_deviation */
  tags: string[];
}

export type CandidateGoal = "cic_request" | "resolve_conflict" | "handoff_condition";

/** Estimated phase (heuristic, not a flight plan). */
export type FlightPhase = "departure" | "arrival" | "overflight";

export interface AgreementConstraint {
  kind: ClearanceKind;
  op: "maintain" | "at_or_below" | "at_or_above";
  value: number;
}

export interface Agreement {
  id: string;
  hex: string;
  callsign: string;
  constraint: AgreementConstraint;
  between: Sector[];
  source: "APREQ" | "handoff" | "CIC";
  /** e.g. "DAL456 maintain 6,000 until clear of JBU811 (APREQ)" */
  text: string;
  createdAt: number;
  expiresAt: number;
  state: "active" | "expired" | "cancelled";
}

export interface Directive {
  id: string;
  target: Sector | "ALL";
  /** The CIC's words. */
  text: string;
  rule?: { type: "no_handoffs" | "altitude_cap" | "altitude_floor" | "other"; value?: number };
  createdAt: number;
  expiresAt: number;
  state: "active" | "expired";
}

export interface SectorEntry {
  entersOther: boolean;
  inSec?: number;
  sector?: Sector;
}

export interface RecentConflict {
  clearance: Clearance;
  secondsAgo: number;
  /** Plain-English why it conflicts, e.g. "reverses direction (descend -> climb)". */
  why: string;
}

/** Facts packet for a sector review (ai-updates.md 5 step 4). Computed by plain code only. */
export interface ReviewFacts {
  phase: FlightPhase;
  probe: ProbeResult;
  candidates: Candidate[];
  brokenAgreements: Agreement[];
  recentConflict: RecentConflict | null;
  sectorEntry: SectorEntry;
  directives: Directive[];
  /** The CIC already confirmed this request (resent with confirmed: true). */
  confirmed: boolean;
}

export type ReviewDecision = "issue" | "unable" | "confirm" | "coordinate";

/** What a sector agent submits with the submit_review tool (ai-updates.md 6). */
export interface SectorReview {
  decision: ReviewDecision;
  chosenCandidateId?: string;
  phraseology: string;
  reason: string;
  question?: string;
  coordinationMessage?: string;
}

export interface ClearanceLogEntry {
  ts: number;
  hex: string;
  callsign: string;
  kind: ClearanceKind;
  value: number;
  turn?: Turn;
  phraseology: string;
  issuedBy: string;
}

export type Status = "none" | "pending" | "conforming" | "non_conforming" | "coasting";

export interface AircraftState {
  hex: string;
  callsign: string;
  clearance: Clearance | null;
  track: Position[];
  status: Status;
  statusReason: string;
  sector: Sector | null;
}

export type HandoffState = "pending" | "accepted" | "unable" | "overdue";
export interface Handoff {
  hex: string;
  callsign: string;
  from: Sector;
  to: Sector;
  startedAt: number;
  dueAt: number;
  state: HandoffState;
  reason?: string;
}

export type ConflictState = "active" | "coordinating" | "resolved" | "escalated";
export interface ConflictAlert {
  id: string;
  a: string;
  b: string;
  hexA: string;
  hexB: string;
  sectors: [Sector, Sector];
  predictedLatNm: number;
  predictedVertFt: number;
  inSec: number;
  state: ConflictState;
  resolution?: string;
  raisedAt: number;
  dueAt: number;
}

/** One transmission heard on a real ATC frequency (LiveATC archive), transcribed and parsed. Evaluation data only. */
export interface HeardTransmission {
  id: string;
  feed: string;
  ts: number;
  durSec: number;
  text: string;
  speaker: "controller" | "pilot" | "unknown";
  /** ICAO callsign matched against ADS-B traffic at that moment, or null. */
  callsign: string | null;
  hex: string | null;
  /** Altitude/heading clearances in the transmission (controller) or read back (pilot). */
  clearances: ClearanceRequest[];
  /** Anything else worth keeping: frequency change, approach clearance, traffic call. */
  note: string | null;
}

export interface FeedItem {
  ts: number;
  from: string;
  /** Channel name ("#radar") or DM recipient name. */
  to: string;
  text: string;
}

export interface AlertItem {
  ts: number;
  kind: "NONCONF" | "CA" | "HANDOFF_OVERDUE" | "ESCALATED" | "OVERRIDE" | "INFO";
  text: string;
}

/** Compact per-aircraft entry kept in the Airspace actor and drawn on the scope. */
export interface TrafficEntry {
  hex: string;
  callsign: string;
  typeCode: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  vertRateFpm: number;
  gsKt: number;
  trackTrueDeg: number;
  status: Status;
  sector: Sector | null;
  ca: boolean;
  ts: number;
  seenSec: number;
  /** Squawking 1200 (VFR). Always set by mergeTraffic; optional for older clients and fixtures. */
  isVfr?: boolean;
}

export interface ConformanceResult {
  status: Status;
  reason: string;
}

// ---------- Evaluation (shadow comparison against the real controller) ----------

/** What the aircraft did after a heard clearance, from recorded ADS-B. */
export type OutcomeResult = "complied" | "in_progress" | "no_change" | "contrary" | "no_data";

/** Second Sight's ruling on a heard clearance, from the same facts the sector agents use. */
export interface ShadowRuling {
  decision: "issue" | "coordinate" | "unable";
  reason: string;
  /** Phraseology of the alternative Second Sight would offer (unable only). */
  alternative: string | null;
  phase: FlightPhase;
  conflicts: ProbeConflict[];
  /**
   * Why this ruling differs from a strict probe (3 NM / 1,000 ft, everyone projected straight), when it does:
   * e.g. "Passes with reduced separation on final (SKW5248)". Null when the strict probe agrees.
   */
  note?: string | null;
}

export interface ClearanceEval {
  id: string;
  ts: number;
  callsign: string;
  hex: string;
  /** Transcript of the controller transmission. */
  text: string;
  req: ClearanceRequest;
  /** Aircraft state when the clearance was heard. */
  before: { altFt: number | null; magTrackDeg: number; vertRateFpm: number } | null;
  outcome: { result: OutcomeResult; detail: string; reachedInSec: number | null };
  ruling: ShadowRuling | null;
  /**
   * Unable rulings only: did the aircraft and the conflicting traffic actually come inside the minimum that applied
   * (recorded ADS-B, next 150 s)? Closest conflict pair reported.
   */
  actualSeparation?: { with: string; basis: SeparationBasis; minLatNm: number | null; vertAtMinFt: number | null; inside: boolean } | null;
  /** Track around the clearance for a sparkline: seconds relative to ts. */
  track: { t: number; altFt: number | null; magTrackDeg: number }[];
}

export interface ConflictEval {
  id: string;
  ts: number;
  a: string;
  b: string;
  predictedInSec: number;
  predictedLatNm: number;
  predictedVertFt: number;
  /** Closest actual approach over the next 150 s of recorded traffic (null when one aircraft dropped out). */
  actualMinLatNm: number | null;
  actualVertAtMinFt: number | null;
  actualLoS: boolean;
  /** A heard controller clearance to either aircraft from 30 s before to 150 s after the alert. */
  controllerActed: boolean;
  actedText: string | null;
  actedAfterSec: number | null;
}

export interface EvalReport {
  icao: string;
  fromTs: number;
  toTs: number;
  /** Data available for range picking. */
  span: { heardFrom: number | null; heardTo: number | null; adsbFrom: number | null; adsbTo: number | null };
  coverage: {
    heard: number;
    controller: number;
    pilot: number;
    unknown: number;
    controllerClearances: number;
    matched: number;
    /** Controller clearances heard while ADS-B was recording (callsigns can only be matched then). */
    duringAdsb: number;
    /** Parsed values that cannot be clearances (speeds read as altitudes, etc.), left out of scoring. */
    implausible: number;
    withAdsb: number;
  };
  kpis: {
    complied: number;
    outcomeKnown: number;
    issue: number;
    coordinate: number;
    unable: number;
    /** Ruled issue/coordinate and the aircraft complied: Second Sight and the controller agreed. */
    agreed: number;
    /** Clearances with a ruling (aircraft on ADS-B when heard). */
    ruled: number;
    /** Ruled issue or coordinate. */
    wouldIssue: number;
    /** Ruled clearances whose outcome was observed: complied, contrary or no_change (not in_progress, not no_data). */
    observed: number;
    /** Among `observed`: ruled issue/coordinate and the aircraft complied. */
    agreedObserved: number;
    /** Ruled clearances still in progress when the outcome window ended. */
    inProgress: number;
    /** Unable rulings where the pair actually came inside the minimum that applied, within 150 s. */
    unableActuallyClose: number;
    /**
     * Among `observed`: Unable rulings where the aircraft complied and the controller deliberately brought the pair
     * inside the standard minimum. Scored as presumed visual separation (pilots' "traffic in sight" is rarely
     * matched on the recording), i.e. Second Sight would have issued it had it known.
     */
    visualAssumed: number;
    /** agreedObserved + visualAssumed: agreement with the controller, visual separation assumed. */
    agreedVisualAdjusted: number;
    /** wouldIssue + Unables presumed visual separation (any outcome). */
    wouldIssueVisualAdjusted: number;
    conflicts: number;
    conflictsWithLoS: number;
    conflictsControllerActed: number;
  };
  bins: { ts: number; heard: number; clearances: number; unable: number; conflicts: number }[];
  clearances: ClearanceEval[];
  conflicts: ConflictEval[];
}
