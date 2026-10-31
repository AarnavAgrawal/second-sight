// Read-only views of the Airspace actor for workflow steps and agent tools (actors are the only source of truth).
import { airspace } from "../../shared/adapters/actors.ts";
import { distToBoundaryNm, trueToMag } from "../../shared/geo.ts";
import { spokenCallsign } from "../../shared/telephony.ts";
import type { Agreement, Airport, ClearanceLogEntry, ConflictAlert, Directive, Handoff, Position, Sector, TrafficEntry } from "../../shared/types.ts";

export interface AirspaceView {
  airport: Airport | null;
  session: number;
  traffic: TrafficEntry[];
  positions: Position[];
  trackControl: Record<string, Sector>;
  handoffs: Handoff[];
  conflicts: ConflictAlert[];
  statuses: Record<string, { status: string; reason: string }>;
  /** Active and recently expired agreements (filter with liveAgreements). */
  agreements: Agreement[];
  /** Active and recently expired CIC directives (filter with liveDirectives). */
  directives: Directive[];
  clearanceLog: ClearanceLogEntry[];
}

/** Active, unexpired agreements, optionally only those involving `sector`. */
export function liveAgreements(view: Pick<AirspaceView, "agreements">, sector?: Sector, now = Date.now()): Agreement[] {
  return view.agreements.filter((a) => a.state === "active" && a.expiresAt > now && (!sector || a.between.includes(sector)));
}

/** Active, unexpired directives, optionally only those addressed to `sector` (or ALL). */
export function liveDirectives(view: Pick<AirspaceView, "directives">, sector?: Sector, now = Date.now()): Directive[] {
  return view.directives.filter((d) => d.state === "active" && d.expiresAt > now && (!sector || d.target === sector || d.target === "ALL"));
}

export function toPosition(t: TrafficEntry): Position {
  return {
    hex: t.hex,
    callsign: t.callsign,
    registration: null,
    typeCode: t.typeCode,
    lat: t.lat,
    lon: t.lon,
    altFt: t.altFt,
    gsKt: t.gsKt,
    trackTrueDeg: t.trackTrueDeg,
    vertRateFpm: t.vertRateFpm,
    seenSec: t.seenSec,
    ts: t.ts,
  };
}

export async function getView(): Promise<AirspaceView> {
  const s = await airspace().snapshot();
  return {
    airport: s.airport,
    session: s.session,
    traffic: s.traffic,
    positions: s.traffic.map(toPosition),
    trackControl: s.trackControl,
    handoffs: s.handoffs,
    conflicts: s.conflicts,
    statuses: s.statuses,
    agreements: s.agreements ?? [],
    directives: s.directives ?? [],
    clearanceLog: s.clearanceLog ?? [],
  };
}

const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Find an aircraft by callsign (exact ICAO callsign first, then loose match on letters/digits, then hex). */
export function findAircraft(view: AirspaceView, callsign: string): TrafficEntry | null {
  const want = norm(callsign);
  if (!want) return null;
  return (
    view.traffic.find((t) => norm(t.callsign) === want) ??
    view.traffic.find((t) => t.hex.toUpperCase() === want) ??
    view.traffic.find((t) => norm(spokenCallsign(t.callsign)) === want) ??
    null
  );
}

/** Compact sector picture for agents. Numbers only come from here or event payloads. */
export function sectorPicture(view: AirspaceView, sector: Sector) {
  const a = view.airport;
  const decl = a?.declinationDeg ?? 0;
  const mine = view.traffic.filter((t) => view.trackControl[t.hex] === sector);
  return {
    airport: a ? { icao: a.icao, name: a.name, elevationFt: a.elevationFt, simplifiedFloorFt: Math.ceil((a.elevationFt + 1500) / 100) * 100 } : null,
    session: view.session,
    sector,
    aircraftCount: mine.length,
    aircraft: mine
      .sort((x, y) => (a ? distToBoundaryNm(x.lat, a) - distToBoundaryNm(y.lat, a) : 0))
      .slice(0, 40)
      .map((t) => ({
        callsign: t.callsign,
        spoken: spokenCallsign(t.callsign),
        altFt: t.altFt,
        vertRateFpm: Math.round(t.vertRateFpm),
        gsKt: Math.round(t.gsKt),
        magTrackDeg: Math.round(trueToMag(t.trackTrueDeg, decl)),
        status: t.status,
        ca: t.ca,
        nmFromBoundary: a ? Math.round(distToBoundaryNm(t.lat, a) * 10) / 10 : null,
      })),
    pendingHandoffs: view.handoffs
      .filter((h) => (h.state === "pending" || h.state === "overdue") && (h.from === sector || h.to === sector))
      .map((h) => ({ callsign: h.callsign, from: h.from, to: h.to, state: h.state, secondsLeft: Math.round((h.dueAt - Date.now()) / 1000) })),
    activeConflicts: view.conflicts
      .filter((c) => c.state !== "resolved" && c.sectors.includes(sector))
      .map((c) => ({ id: c.id, a: c.a, b: c.b, sectors: c.sectors, predictedLatNm: c.predictedLatNm, predictedVertFt: c.predictedVertFt, inSec: c.inSec, state: c.state, resolution: c.resolution ?? null })),
    activeAgreements: liveAgreements(view, sector).map((g) => ({
      id: g.id,
      callsign: g.callsign,
      constraint: g.constraint,
      source: g.source,
      text: g.text,
      secondsLeft: Math.round((g.expiresAt - Date.now()) / 1000),
    })),
    activeDirectives: liveDirectives(view, sector).map((d) => ({
      id: d.id,
      target: d.target,
      text: d.text,
      rule: d.rule ?? null,
      secondsLeft: Math.round((d.expiresAt - Date.now()) / 1000),
    })),
  };
}
