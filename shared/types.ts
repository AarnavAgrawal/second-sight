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
  minLatNm: number;
  minVertFt: number;
  inSec: number;
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
}

export interface ConformanceResult {
  status: Status;
  reason: string;
}
