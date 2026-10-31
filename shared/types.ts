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
