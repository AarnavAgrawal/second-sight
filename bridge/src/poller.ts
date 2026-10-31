// The bridge loop: every 5 s fetch ADS-B, push to actors, run conformance, conflict alert, and boundary detection.
// All state that matters lives in the actors; the caches here are derived and reset on every session.
import { aircraft, airspace } from "../../shared/adapters/actors.ts";
import { normalizeAdsb } from "../../shared/adsb.ts";
import { boundaryApproach } from "../../shared/boundary.ts";
import { formatAltitude } from "../../shared/conformance.ts";
import { haversineNm, trueToMag } from "../../shared/geo.ts";
import { conflictAlert } from "../../shared/separation.ts";
import type { Airport, Position, Sector } from "../../shared/types.ts";
import { config } from "./config.ts";
import { postRadar } from "./radar.ts";
import { LiveSource, ReplaySource, type Source } from "./source.ts";

const CA_DEBOUNCE_MS = 30_000;
const CA_CLEAR_AFTER_MISSES = 2;
const CA_SUPPRESS_AFTER_RESOLVED_MS = 3 * 60_000;

const hundreds = (ft: number | null) => (ft == null ? "---" : String(Math.max(0, Math.round(ft / 100))).padStart(3, "0"));
const trend = (vr: number) => (vr > 500 ? "climbing" : vr < -500 ? "descending" : "level");
const fpm = (vr: number) => `${Math.abs(Math.round(vr / 100) * 100).toLocaleString("en-US")} fpm`;
const pairKey = (x: string, y: string) => [x, y].sort().join("|");

/** Drop TIS-B/ADS-R shadow targets (non-ICAO "~" hex) that duplicate a real ICAO target. */
function dropShadows(positions: Position[]): Position[] {
  const real = positions.filter((p) => !p.hex.startsWith("~"));
  return positions.filter(
    (p) =>
      !p.hex.startsWith("~") ||
      !real.some((r) => haversineNm(p.lat, p.lon, r.lat, r.lon) < 0.5 && Math.abs((p.altFt ?? 0) - (r.altFt ?? 0)) < 300),
  );
}

export interface PollerStatus {
  airport: Airport | null;
  session: number;
  dataSource: "live" | "replay";
  lastPollAt: number | null;
  lastError: string | null;
  aircraftCount: number;
  replayFile?: string;
}

class Poller {
  airport: Airport | null = null;
  session = 0;
  source: Source | null = null;
  latest = new Map<string, Position>();
  positions: Position[] = [];
  lastPollAt: number | null = null;
  lastError: string | null = null;
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Derived caches (reset per session).
  private boundaryEmitted = new Set<string>();
  private caLastRaised = new Map<string, number>();
  private caMisses = new Map<string, number>();
  private caSuppressUntil = new Map<string, number>();
  private seenResolved = new Set<string>();

  status(): PollerStatus {
    return {
      airport: this.airport,
      session: this.session,
      dataSource: config.dataSource,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      aircraftCount: this.positions.length,
      replayFile: this.source instanceof ReplaySource ? this.source.file : undefined,
    };
  }

  /** Start (or restart) polling for an airport. Returns an error string if the data source can't start. */
  async start(airport: Airport, session: number): Promise<string | null> {
    this.stop();
    this.airport = airport;
    this.session = session;
    this.latest.clear();
    this.positions = [];
    this.boundaryEmitted.clear();
    this.caLastRaised.clear();
    this.caMisses.clear();
    this.caSuppressUntil.clear();
    this.seenResolved.clear();
    this.lastError = null;
    if (config.dataSource === "replay") {
      const r = await ReplaySource.open(airport);
      if ("error" in r) {
        this.lastError = r.error;
        return r.error;
      }
      this.source = r;
    } else {
      this.source = new LiveSource(airport);
    }
    const gen = ++this.gen;
    const loop = async () => {
      if (gen !== this.gen) return;
      const t0 = Date.now();
      try {
        await this.tick(gen);
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
        console.error("[poll]", this.lastError);
      }
      if (gen === this.gen) this.timer = setTimeout(loop, Math.max(500, config.pollMs - (Date.now() - t0)));
    };
    void loop();
    return null;
  }

  stop() {
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.source?.close();
    this.source = null;
  }

  private async tick(gen: number) {
    const airport = this.airport;
    const source = this.source;
    if (!airport || !source) return;
    const snap = await source.next();
    if (gen !== this.gen) return;
    const now = Date.now();
    const positions = dropShadows(normalizeAdsb(snap, airport, now));
    // Terminal conflict alert and handoffs are for tracked IFR traffic (discrete squawk, not VFR 1200).
    // CA eligibility: a known, non-VFR squawk (drops TIS-B/unknown targets that carry no squawk).
    const discrete = new Set(snap.ac.filter((a) => a.squawk != null && String(a.squawk) !== "1200").map((a) => String(a.hex).toLowerCase()));
    this.positions = positions;
    this.latest = new Map(positions.map((p) => [p.hex, p]));
    this.lastPollAt = now;

    const space = airspace();
    const upd = await space.updateTraffic(positions, this.session);
    if (!upd.ok || upd.session !== this.session || gen !== this.gen) return;
    const tc = upd.trackControl as Record<string, Sector>;
    const snapState = await space.snapshot();
    if (gen !== this.gen) return;

    // Replay scenarios may focus CA/BOUNDARY on their scripted aircraft (scenario.json "focusCallsigns").
    const focus = this.source instanceof ReplaySource ? this.source.focusCallsigns : null;
    const eligible = positions.filter((p) => discrete.has(p.hex));
    await this.conformance(positions, snapState.statuses, tc);
    if (gen !== this.gen) return;
    await this.conflicts(eligible, tc, snapState.conflicts, airport, now, focus);
    if (gen !== this.gen) return;
    await this.boundaries(focus ? eligible.filter((p) => focus.has(p.callsign)) : eligible, tc, snapState.handoffs, airport);
  }

  /** Feed positions to Aircraft actors that have an active clearance. */
  private async conformance(positions: Position[], statuses: Record<string, { status: string }>, tc: Record<string, Sector>) {
    const active = Object.entries(statuses).filter(([, s]) => s.status !== "none").map(([hex]) => hex);
    await Promise.all(
      active.map(async (hex) => {
        const pos = this.latest.get(hex);
        if (!pos) return;
        try {
          const r = await aircraft(hex).ingestPosition(pos);
          if (!r.changed) return;
          await airspace().setStatus(hex, r.status, r.reason);
          if (r.status === "non_conforming") await this.postNonconf(pos, tc[hex] ?? null, r.reason);
        } catch (e) {
          console.error(`[conformance] ${hex}`, (e as Error).message);
        }
      }),
    );
  }

  private async postNonconf(pos: Position, owner: Sector | null, reason: string) {
    const st = await aircraft(pos.hex).getState();
    const c = st.clearance;
    if (!c) return;
    const decl = this.airport?.declinationDeg ?? 0;
    const magTrack = Math.round(trueToMag(pos.trackTrueDeg, decl));
    const text =
      c.kind === "altitude"
        ? `NONCONF ${pos.callsign} cleared ${hundreds(c.value)}, now ${hundreds(pos.altFt)} ${trend(pos.vertRateFpm)}${Math.abs(pos.vertRateFpm) > 500 ? ` ${fpm(pos.vertRateFpm)}` : ""} (owner ${owner ?? "none"})`
        : `NONCONF ${pos.callsign} cleared heading ${String(c.value).padStart(3, "0")}, now tracking ${String(magTrack).padStart(3, "0")} (owner ${owner ?? "none"})`;
    await postRadar(text, {
      type: "NONCONF",
      session: this.session,
      hex: pos.hex,
      callsign: pos.callsign,
      owner,
      clearance: { kind: c.kind, value: c.value, turn: c.turn ?? null, issuedAt: c.issuedAt, issuedBy: c.issuedBy },
      clearedText: c.kind === "altitude" ? formatAltitude(c.value) : `heading ${String(c.value).padStart(3, "0")}`,
      altFt: pos.altFt,
      vertRateFpm: Math.round(pos.vertRateFpm),
      gsKt: Math.round(pos.gsKt),
      magTrackDeg: magTrack,
      reason,
    });
  }

  private async conflicts(
    positions: Position[],
    tc: Record<string, Sector>,
    existing: { id: string; hexA: string; hexB: string; state: string }[],
    airport: Airport,
    now: number,
    focus: Set<string> | null = null,
  ) {
    // Terminal-area rule: pairs where both aircraft are in the approach/departure corridor
    // (within 6 NM of the field and below 3,000 ft AGL) are parallel-runway traffic, not conflicts.
    const inCorridor = (p: Position) =>
      haversineNm(p.lat, p.lon, airport.lat, airport.lon) < 6 && (p.altFt ?? 0) < airport.elevationFt + 3000;
    const preds = conflictAlert(positions, airport).filter((c) => {
      const a = this.latest.get(c.hexA);
      const b = this.latest.get(c.hexB);
      if (!a || !b) return false;
      if (focus && !focus.has(a.callsign) && !focus.has(b.callsign)) return false;
      if (inCorridor(a) && inCorridor(b)) return false;
      // Low-level GA: both aircraft below the CA floor (default 2,500 ft AGL) are not alerted.
      const floor = airport.elevationFt + config.caFloorAglFt;
      return !((a.altFt ?? 0) < floor && (b.altFt ?? 0) < floor);
    });
    const predicted = new Set(preds.map((p) => pairKey(p.hexA, p.hexB)));
    const open = existing.filter((c) => c.state !== "resolved");

    // Agents resolved it: don't re-alert the same pair for a while (real aircraft can't hear our resolution).
    for (const c of existing) {
      if (c.state === "resolved" && !this.seenResolved.has(c.id)) {
        this.seenResolved.add(c.id);
        this.caSuppressUntil.set(pairKey(c.hexA, c.hexB), now + CA_SUPPRESS_AFTER_RESOLVED_MS);
      }
    }

    for (const p of preds) {
      const key = pairKey(p.hexA, p.hexB);
      this.caMisses.delete(key);
      const isOpen = open.some((c) => pairKey(c.hexA, c.hexB) === key);
      if (!isOpen) {
        if ((this.caSuppressUntil.get(key) ?? 0) > now) continue;
        if (now - (this.caLastRaised.get(key) ?? 0) < CA_DEBOUNCE_MS) continue;
      }
      const pa = this.latest.get(p.hexA)!;
      const pb = this.latest.get(p.hexB)!;
      const sectors: [Sector, Sector] = [tc[p.hexA] ?? (pa.lat >= airport.lat ? "NORTH" : "SOUTH"), tc[p.hexB] ?? (pb.lat >= airport.lat ? "NORTH" : "SOUTH")];
      const r = await airspace().raiseConflict({
        hexA: p.hexA,
        hexB: p.hexB,
        a: p.a,
        b: p.b,
        sectors,
        predictedLatNm: Math.round(p.minLatNm * 10) / 10,
        predictedVertFt: Math.round(p.minVertFt / 100) * 100,
        inSec: p.inSec,
      });
      if (!r.isNew) continue;
      this.caLastRaised.set(key, now);
      const c = r.conflict;
      const ac = (pos: Position, s: Sector) => ({
        callsign: pos.callsign,
        hex: pos.hex,
        altFt: pos.altFt,
        vertRateFpm: Math.round(pos.vertRateFpm),
        gsKt: Math.round(pos.gsKt),
        trackTrueDeg: Math.round(pos.trackTrueDeg),
        magTrackDeg: Math.round(trueToMag(pos.trackTrueDeg, airport.declinationDeg)),
        sector: s,
      });
      await postRadar(
        `CA ${c.a}/${c.b} predicted ${c.predictedLatNm.toFixed(1)} NM / ${c.predictedVertFt} FT in ${c.inSec} s (${c.sectors[0]}/${c.sectors[1]})`,
        {
          type: "CA",
          session: this.session,
          id: c.id,
          a: c.a,
          b: c.b,
          hexA: c.hexA,
          hexB: c.hexB,
          sectors: c.sectors,
          crossSector: c.sectors[0] !== c.sectors[1],
          predictedLatNm: c.predictedLatNm,
          predictedVertFt: c.predictedVertFt,
          inSec: c.inSec,
          aircraft: [ac(pa, sectors[0]), ac(pb, sectors[1])],
        },
      );
    }

    // Clear CAs that are no longer predicted (after 2 consecutive misses, to avoid flicker).
    for (const c of open) {
      const key = pairKey(c.hexA, c.hexB);
      if (predicted.has(key)) continue;
      const misses = (this.caMisses.get(key) ?? 0) + 1;
      this.caMisses.set(key, misses);
      if (misses >= CA_CLEAR_AFTER_MISSES) {
        this.caMisses.delete(key);
        await airspace().clearConflict(c.id);
      }
    }
  }

  private async boundaries(positions: Position[], tc: Record<string, Sector>, handoffs: { hex: string; state: string }[], airport: Airport) {
    const pending = new Set(handoffs.filter((h) => h.state === "pending" || h.state === "overdue").map((h) => h.hex));
    // Forget emissions once ownership changed (new crossing possible).
    for (const k of [...this.boundaryEmitted]) {
      const [hex, owner] = k.split(":");
      if (!this.latest.has(hex!) || tc[hex!] !== owner) this.boundaryEmitted.delete(k);
    }
    for (const p of positions) {
      const owner = tc[p.hex];
      if (!owner || pending.has(p.hex)) continue;
      if (p.altFt == null || p.altFt >= config.handoffCeilingFt) continue;
      const key = `${p.hex}:${owner}`;
      if (this.boundaryEmitted.has(key)) continue;
      const b = boundaryApproach(p, airport, owner);
      if (!b) continue;
      this.boundaryEmitted.add(key);
      const side = p.lat >= airport.lat ? "north" : "south";
      await postRadar(
        `BOUNDARY ${p.callsign} ${b.from}->${b.to} in ${b.distNm.toFixed(1)} NM, ${hundreds(p.altFt)} ${trend(p.vertRateFpm)}`,
        {
          type: "BOUNDARY",
          session: this.session,
          hex: p.hex,
          callsign: p.callsign,
          from: b.from,
          to: b.to,
          distNm: b.distNm,
          side,
          altFt: p.altFt,
          vertRateFpm: Math.round(p.vertRateFpm),
          gsKt: Math.round(p.gsKt),
          trackTrueDeg: Math.round(p.trackTrueDeg),
          lat: p.lat,
          lon: p.lon,
        },
      );
    }
  }
}

export const poller = new Poller();
