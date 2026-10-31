// Shapes of the bridge HTTP API and actor emitted state, as consumed by the UI.
import type {
  AlertItem,
  Airport,
  Clearance,
  ClearanceKind,
  ConflictAlert,
  FeedItem,
  Handoff,
  Position,
  ProbeResult,
  Sector,
  Status,
  TrafficEntry,
  Turn,
} from "@shared/types.ts";

export interface BridgeConfig {
  dataSource: "live" | "replay";
  radiusNm: number;
  relayObserverUrl?: string;
}

export interface AirportSuggestion {
  icao: string;
  name: string;
  city: string;
}

export type AirportLookup = { ok: true; airport: Airport } | { ok: false; error: string; suggestions: AirportSuggestion[] };

export interface AirspaceState {
  airport: Airport | null;
  traffic: TrafficEntry[];
  trackControl: Record<string, Sector>;
  handoffs: Handoff[];
  conflicts: ConflictAlert[];
  feed: FeedItem[];
  alerts: AlertItem[];
}

export interface AircraftActorState {
  callsign: string;
  clearance: Clearance | null;
  track: Position[];
  status: Status;
  statusReason: string;
}

export type StepId = "parse" | "resolve" | "probe" | "sectorReview" | "issue";
export interface ClearanceStep {
  id: StepId;
  status: "ok" | "fail" | "skipped";
  detail: string;
  ms: number;
}

export interface ClearanceResponse {
  issued: boolean;
  transcript: string;
  parsed?: { callsign: string; kind: ClearanceKind; value: number; turn?: Turn };
  hex?: string;
  sector?: Sector;
  phraseology?: string;
  probe?: ProbeResult;
  reason?: string;
  alternative?: { kind: ClearanceKind; value: number; turn?: Turn; text: string };
  sayAgain?: boolean;
  suggestions?: string[];
  override?: boolean;
  steps: ClearanceStep[];
  error?: string;
}

export interface Grant {
  websocketUrl: string;
  connectByMs: number;
}

export type ActorName = "Airspace" | "Aircraft";

/** Wire messages from a Terse actor websocket. */
export type ActorMessage =
  | { type: "state"; state: Record<string, unknown>; version?: number }
  | { type: "state_update"; changes?: Record<string, unknown>; removed?: string[]; version?: number }
  | { type: string; [k: string]: unknown };
