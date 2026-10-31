// Terse Durable Actors for Second Sight (CLAUDE.md section 8).
// Airspace (id "main") owns the airport, traffic, track control, handoffs, conflict alerts, feed.
// Aircraft (id = ICAO hex) owns one aircraft's clearance and conformance timer.
// Actors process one call at a time, so track control can never be split during a handoff.
import { Actor, Emittable, Persisted } from "terse-sdk/actor";
import type {
  AlertItem,
  Airport,
  Clearance,
  ConflictAlert,
  ConflictState,
  FeedItem,
  Handoff,
  Position,
  Sector,
  Status,
  TrafficEntry,
} from "../../shared/types.ts";
import { sectorOf } from "../../shared/geo.ts";
import { evaluateConformance } from "../../shared/conformance.ts";

const HANDOFF_DUE_MS = 30_000;
const CONFLICT_DUE_MS = 30_000;
const FEED_MAX = 100;
const ALERTS_MAX = 20;
const RESOLVED_KEEP = 10;
const HANDOFFS_KEEP = 20;
const TRACK_MAX = 24;
const AIRCRAFT_RECHECK_MS = 10_000;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export interface RaiseConflictInput {
  hexA: string;
  hexB: string;
  a: string;
  b: string;
  sectors: [Sector, Sector];
  predictedLatNm: number;
  predictedVertFt: number;
  inSec: number;
}

const OPEN_CONFLICT: ConflictState[] = ["active", "coordinating", "escalated"];
const isOpen = (c: ConflictAlert) => OPEN_CONFLICT.includes(c.state);

export class Airspace extends Actor {
  @Persisted @Emittable airport: Airport | null = null;
  @Persisted @Emittable traffic: TrafficEntry[] = [];
  @Persisted @Emittable trackControl: Record<string, Sector> = {};
  @Persisted @Emittable handoffs: Handoff[] = [];
  @Persisted @Emittable conflicts: ConflictAlert[] = [];
  @Persisted @Emittable feed: FeedItem[] = [];
  @Persisted @Emittable alerts: AlertItem[] = [];
  /** Increments every time an airport is configured, so stale work can be dropped. */
  @Persisted @Emittable session = 0;
  /** Conformance status per hex, merged into `traffic` on every poll. */
  @Persisted statuses: Record<string, { status: Status; reason: string }> = {};

  async snapshot(): Promise<{
    airport: Airport | null;
    traffic: TrafficEntry[];
    trackControl: Record<string, Sector>;
    handoffs: Handoff[];
    conflicts: ConflictAlert[];
    alerts: AlertItem[];
    session: number;
    statuses: Record<string, { status: Status; reason: string }>;
  }> {
    return {
      airport: this.airport,
      traffic: this.traffic,
      trackControl: this.trackControl,
      handoffs: this.handoffs,
      conflicts: this.conflicts,
      alerts: this.alerts,
      session: this.session,
      statuses: this.statuses,
    };
  }

  async getAirport(): Promise<{ airport: Airport | null; session: number }> {
    return { airport: this.airport, session: this.session };
  }

  async getFeed(limit: number): Promise<FeedItem[]> {
    return this.feed.slice(-Math.max(1, Math.min(limit, FEED_MAX)));
  }

  async configure(airport: Airport): Promise<{ ok: true; session: number }> {
    const now = Date.now();
    await this.db.transaction(async () => {
      this.airport = airport;
      this.traffic = [];
      this.trackControl = {};
      this.handoffs = [];
      this.conflicts = [];
      this.alerts = [];
      this.statuses = {};
      this.session = this.session + 1;
      this.feed = [
        ...this.feed,
        { ts: now, from: "SYSTEM", to: "#radar", text: `Now controlling ${airport.icao} (${airport.name})` },
      ].slice(-FEED_MAX);
    });
    this.alarm.delete();
    return { ok: true, session: this.session };
  }

  /** Called by the bridge every poll with the full set of aircraft in range. */
  async updateTraffic(batch: Position[]): Promise<{ ok: boolean; trackControl: Record<string, Sector>; session: number }> {
    const airport = this.airport;
    if (!airport) return { ok: false, trackControl: {}, session: this.session };

    const inBatch = new Set(batch.map((p) => p.hex));
    const pendingHandoff = new Set(this.handoffs.filter((h) => h.state === "pending").map((h) => h.hex));

    // Track control: keep existing owners, assign new aircraft by geometry, drop aircraft that left.
    const tc: Record<string, Sector> = {};
    for (const p of batch) {
      const owner = this.trackControl[p.hex];
      if (owner) tc[p.hex] = owner;
      else if (!pendingHandoff.has(p.hex)) tc[p.hex] = sectorOf(p.lat, airport);
    }
    if (JSON.stringify(tc) !== JSON.stringify(this.trackControl)) this.trackControl = tc;

    const caHex = new Set<string>();
    for (const c of this.conflicts) if (isOpen(c)) { caHex.add(c.hexA); caHex.add(c.hexB); }

    this.traffic = batch.map((p) => ({
      hex: p.hex,
      callsign: p.callsign,
      typeCode: p.typeCode,
      lat: p.lat,
      lon: p.lon,
      altFt: p.altFt,
      vertRateFpm: p.vertRateFpm,
      gsKt: p.gsKt,
      trackTrueDeg: p.trackTrueDeg,
      status: this.statuses[p.hex]?.status ?? "none",
      sector: tc[p.hex] ?? null,
      ca: caHex.has(p.hex),
      ts: p.ts,
      seenSec: p.seenSec,
    }));

    // Pending handoffs for aircraft that left range are dropped.
    const kept = this.handoffs.filter((h) => h.state !== "pending" || inBatch.has(h.hex));
    if (kept.length !== this.handoffs.length) this.handoffs = kept;

    return { ok: true, trackControl: tc, session: this.session };
  }

  async setStatus(hex: string, status: Status, reason: string): Promise<{ ok: true }> {
    this.statuses = { ...this.statuses, [hex]: { status, reason } };
    if (this.traffic.some((t) => t.hex === hex)) {
      this.traffic = this.traffic.map((t) => (t.hex === hex ? { ...t, status } : t));
    }
    return { ok: true };
  }

  async initiateHandoff(hex: string, from: Sector, to: Sector): Promise<{ ok: true; handoff: Handoff } | Fail> {
    if (from === to) return fail("Handoff must be to the other sector.");
    const owner = this.trackControl[hex];
    if (!owner) return fail(`No track control record for ${hex}.`);
    if (owner !== from) return fail(`${from} does not have track control (owner ${owner}).`);
    if (this.handoffs.some((h) => h.hex === hex && h.state === "pending")) return fail("A handoff is already pending.");
    const now = Date.now();
    const callsign = this.traffic.find((t) => t.hex === hex)?.callsign ?? hex.toUpperCase();
    const handoff: Handoff = { hex, callsign, from, to, startedAt: now, dueAt: now + HANDOFF_DUE_MS, state: "pending" };
    this.handoffs = [...this.handoffs.filter((h) => h.hex !== hex || h.state === "pending"), handoff].slice(-HANDOFFS_KEEP);
    armAirspaceAlarm(this);
    return { ok: true, handoff };
  }

  /** Atomically transfers track control to `by` and marks the handoff accepted. */
  async acceptHandoff(hex: string, by: Sector): Promise<{ ok: true; handoff: Handoff } | Fail> {
    const h = this.handoffs.find((x) => x.hex === hex && (x.state === "pending" || x.state === "overdue"));
    if (!h) return fail("No pending handoff for this aircraft.");
    if (h.to !== by) return fail(`${by} is not the receiving sector (receiving ${h.to}).`);
    const accepted: Handoff = { ...h, state: "accepted" };
    await this.db.transaction(async () => {
      this.trackControl = { ...this.trackControl, [hex]: by };
      this.handoffs = this.handoffs.map((x) => (x === h ? accepted : x));
      this.traffic = this.traffic.map((t) => (t.hex === hex ? { ...t, sector: by } : t));
    });
    armAirspaceAlarm(this);
    return { ok: true, handoff: accepted };
  }

  async rejectHandoff(hex: string, by: Sector, reason: string): Promise<{ ok: true; handoff: Handoff } | Fail> {
    const h = this.handoffs.find((x) => x.hex === hex && (x.state === "pending" || x.state === "overdue"));
    if (!h) return fail("No pending handoff for this aircraft.");
    if (h.to !== by) return fail(`${by} is not the receiving sector (receiving ${h.to}).`);
    const rejected: Handoff = { ...h, state: "unable", reason };
    this.handoffs = this.handoffs.map((x) => (x === h ? rejected : x));
    armAirspaceAlarm(this);
    return { ok: true, handoff: rejected };
  }

  async raiseConflict(input: RaiseConflictInput): Promise<{ ok: true; conflict: ConflictAlert; isNew: boolean }> {
    const now = Date.now();
    const existing = this.conflicts.find(
      (c) => isOpen(c) && ((c.hexA === input.hexA && c.hexB === input.hexB) || (c.hexA === input.hexB && c.hexB === input.hexA)),
    );
    let conflict: ConflictAlert;
    let isNew = false;
    if (existing) {
      conflict = { ...existing, predictedLatNm: input.predictedLatNm, predictedVertFt: input.predictedVertFt, inSec: input.inSec };
      this.conflicts = this.conflicts.map((c) => (c.id === existing.id ? conflict : c));
    } else {
      isNew = true;
      conflict = {
        id: `CA-${input.a}-${input.b}-${now.toString(36).slice(-5)}`,
        ...input,
        state: "active",
        raisedAt: now,
        dueAt: now + CONFLICT_DUE_MS,
      };
      this.conflicts = trimConflicts([...this.conflicts, conflict]);
      markCa(this);
      armAirspaceAlarm(this);
    }
    return { ok: true, conflict, isNew };
  }

  async updateConflict(id: string, patch: { state?: ConflictState; resolution?: string }): Promise<{ ok: true; conflict: ConflictAlert } | Fail> {
    const c = this.conflicts.find((x) => x.id === id);
    if (!c) return fail(`No conflict alert ${id}.`);
    const next: ConflictAlert = { ...c, ...(patch.state ? { state: patch.state } : {}), ...(patch.resolution ? { resolution: patch.resolution } : {}) };
    this.conflicts = trimConflicts(this.conflicts.map((x) => (x.id === id ? next : x)));
    if (patch.state === "escalated" && c.state !== "escalated") {
      pushAlert(this, { ts: Date.now(), kind: "ESCALATED", text: `CA ${c.a}/${c.b} escalated to CIC.` });
    }
    markCa(this);
    armAirspaceAlarm(this);
    return { ok: true, conflict: next };
  }

  /** Called by the bridge when a CA is no longer predicted. */
  async clearConflict(id: string): Promise<{ ok: true } | Fail> {
    const c = this.conflicts.find((x) => x.id === id);
    if (!c) return fail(`No conflict alert ${id}.`);
    if (c.state !== "resolved") {
      const next: ConflictAlert = { ...c, state: "resolved", resolution: c.resolution ?? "No longer predicted." };
      this.conflicts = trimConflicts(this.conflicts.map((x) => (x.id === id ? next : x)));
      markCa(this);
      armAirspaceAlarm(this);
    }
    return { ok: true };
  }

  async appendFeed(item: FeedItem): Promise<{ ok: true }> {
    this.feed = [...this.feed, item].slice(-FEED_MAX);
    return { ok: true };
  }

  async addAlert(alert: AlertItem): Promise<{ ok: true }> {
    pushAlert(this, alert);
    return { ok: true };
  }

  async onAlarm(): Promise<void> {
    const now = Date.now();
    const overdue = this.handoffs.filter((h) => h.state === "pending" && h.dueAt <= now);
    if (overdue.length) {
      this.handoffs = this.handoffs.map((h) => (overdue.includes(h) ? { ...h, state: "overdue" } : h));
      for (const h of overdue) {
        pushAlert(this, { ts: now, kind: "HANDOFF_OVERDUE", text: `Handoff ${h.callsign} ${h.from}->${h.to} not accepted in 30 s.` });
      }
    }
    const escalate = this.conflicts.filter((c) => (c.state === "active" || c.state === "coordinating") && c.dueAt <= now);
    if (escalate.length) {
      this.conflicts = this.conflicts.map((c) => (escalate.includes(c) ? { ...c, state: "escalated" } : c));
      for (const c of escalate) {
        pushAlert(this, { ts: now, kind: "ESCALATED", text: `CA ${c.a}/${c.b} unresolved after 30 s. Escalated to CIC.` });
      }
    }
    armAirspaceAlarm(this);
  }
}

export class Aircraft extends Actor {
  @Persisted @Emittable callsign = "";
  @Persisted @Emittable clearance: Clearance | null = null;
  @Persisted @Emittable track: Position[] = [];
  @Persisted @Emittable status: Status = "none";
  @Persisted @Emittable statusReason = "";
  @Persisted declinationDeg = 0;
  /** Last status returned to the bridge from ingestPosition, so alarm-driven changes are still reported. */
  @Persisted reportedStatus: Status = "none";

  async getState(): Promise<{ hex: string; callsign: string; clearance: Clearance | null; track: Position[]; status: Status; statusReason: string }> {
    return { hex: this.id, callsign: this.callsign, clearance: this.clearance, track: this.track, status: this.status, statusReason: this.statusReason };
  }

  async issueClearance(input: {
    clearance: Clearance;
    callsign: string;
    declinationDeg: number;
    position?: Position | null;
  }): Promise<{ status: Status; reason: string }> {
    this.callsign = input.callsign;
    this.declinationDeg = input.declinationDeg;
    if (input.position) appendTrack(this, input.position);
    this.clearance = input.clearance;
    setAircraftStatus(this, "pending", "Clearance issued. Awaiting response.");
    evaluateAircraft(this, Date.now());
    this.alarm.set(Math.min(input.clearance.graceUntil, Date.now() + AIRCRAFT_RECHECK_MS));
    return { status: this.status, reason: this.statusReason };
  }

  async cancelClearance(): Promise<{ ok: true }> {
    this.clearance = null;
    setAircraftStatus(this, "none", "");
    this.alarm.delete();
    return { ok: true };
  }

  async ingestPosition(pos: Position): Promise<{ status: Status; changed: boolean; reason: string }> {
    appendTrack(this, pos);
    if (this.clearance) evaluateAircraft(this, Date.now());
    const changed = this.status !== this.reportedStatus;
    if (changed) this.reportedStatus = this.status;
    return { status: this.status, changed, reason: this.statusReason };
  }

  async onAlarm(): Promise<void> {
    if (!this.clearance) return;
    const now = Date.now();
    evaluateAircraft(this, now);
    const { graceUntil, deadlineAt } = this.clearance;
    // Re-check at grace and deadline exactly, otherwise every 10 s while a clearance is active.
    const next = [graceUntil, deadlineAt, now + AIRCRAFT_RECHECK_MS].filter((t) => t > now);
    this.alarm.set(Math.min(...next));
  }
}

// ---- helpers (module-level: Terse treats every class method as an async actor method) ----

function armAirspaceAlarm(a: Airspace): void {
  const dues = [
    ...a.handoffs.filter((h) => h.state === "pending").map((h) => h.dueAt),
    ...a.conflicts.filter((c) => c.state === "active" || c.state === "coordinating").map((c) => c.dueAt),
  ];
  if (dues.length) a.alarm.set(Math.min(...dues));
  else a.alarm.delete();
}

function trimConflicts(list: ConflictAlert[]): ConflictAlert[] {
  const open = list.filter(isOpen);
  const resolved = list.filter((c) => !isOpen(c)).slice(-RESOLVED_KEEP);
  return [...open, ...resolved].sort((x, y) => x.raisedAt - y.raisedAt);
}

function markCa(a: Airspace): void {
  const caHex = new Set<string>();
  for (const c of a.conflicts) if (isOpen(c)) { caHex.add(c.hexA); caHex.add(c.hexB); }
  if (a.traffic.some((t) => t.ca !== caHex.has(t.hex))) {
    a.traffic = a.traffic.map((t) => ({ ...t, ca: caHex.has(t.hex) }));
  }
}

function pushAlert(a: Airspace, alert: AlertItem): void {
  a.alerts = [...a.alerts, alert].slice(-ALERTS_MAX);
}

function appendTrack(ac: Aircraft, pos: Position): void {
  const last = ac.track[ac.track.length - 1];
  if (last && last.ts === pos.ts) return;
  ac.track = [...ac.track, pos].slice(-TRACK_MAX);
  if (pos.callsign && pos.callsign !== ac.callsign) ac.callsign = pos.callsign;
}

function evaluateAircraft(ac: Aircraft, now: number): void {
  if (!ac.clearance) return;
  const r = evaluateConformance(ac.clearance, ac.track, now, ac.declinationDeg);
  setAircraftStatus(ac, r.status, r.reason);
}

function setAircraftStatus(ac: Aircraft, status: Status, reason: string): void {
  const changed = status !== ac.status;
  if (changed) ac.status = status;
  if (reason !== ac.statusReason) ac.statusReason = reason;
  if (changed) {
    // broadcast/id are protected on Actor; this helper is part of the Aircraft implementation.
    const self = ac as unknown as { id: string; broadcast(message: unknown): void };
    self.broadcast({ type: "status", hex: self.id, status, reason });
  }
}
