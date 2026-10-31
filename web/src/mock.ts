// In-browser mock of the bridge + actors, enabled with ?mock=1. For UI development only:
// fake traffic is never shown in live mode.
import { destination, haversineNm, sectorOf } from "@shared/geo.ts";
import type {
  AlertItem,
  Airport,
  Clearance,
  ConflictAlert,
  FeedItem,
  Handoff,
  Position,
  Sector,
  Status,
  TrafficEntry,
} from "@shared/types.ts";
import type { SocketLike } from "./api.ts";
import type {
  ActorName,
  AircraftActorState,
  AirportLookup,
  AirspaceState,
  BridgeConfig,
  ClearanceResponse,
  Grant,
} from "./apiTypes.ts";

const RADIUS = 35;
const params = new URLSearchParams(location.search);

const AIRPORTS: Airport[] = [
  { icao: "KSFO", name: "San Francisco International Airport", city: "San Francisco", state: "CA", lat: 37.6189, lon: -122.375, elevationFt: 13, radiusNm: RADIUS, declinationDeg: 13 },
  { icao: "KLAX", name: "Los Angeles International Airport", city: "Los Angeles", state: "CA", lat: 33.9425, lon: -118.408, elevationFt: 125, radiusNm: RADIUS, declinationDeg: 11.5 },
  { icao: "KJFK", name: "John F Kennedy International Airport", city: "New York", state: "NY", lat: 40.6398, lon: -73.7789, elevationFt: 13, radiusNm: RADIUS, declinationDeg: -12.8 },
  { icao: "KATL", name: "Hartsfield Jackson Atlanta International Airport", city: "Atlanta", state: "GA", lat: 33.6367, lon: -84.4281, elevationFt: 1026, radiusNm: RADIUS, declinationDeg: -5 },
  { icao: "KORD", name: "Chicago O'Hare International Airport", city: "Chicago", state: "IL", lat: 41.9786, lon: -87.9048, elevationFt: 672, radiusNm: RADIUS, declinationDeg: -3.5 },
  { icao: "KDFW", name: "Dallas Fort Worth International Airport", city: "Dallas-Fort Worth", state: "TX", lat: 32.8968, lon: -97.038, elevationFt: 607, radiusNm: RADIUS, declinationDeg: 2.6 },
  { icao: "KSJC", name: "Norman Y. Mineta San Jose International Airport", city: "San Jose", state: "CA", lat: 37.3626, lon: -121.929, elevationFt: 62, radiusNm: RADIUS, declinationDeg: 13 },
  { icao: "KSEA", name: "Seattle Tacoma International Airport", city: "Seattle", state: "WA", lat: 47.449, lon: -122.309, elevationFt: 433, radiusNm: RADIUS, declinationDeg: 15 },
];

const CALLSIGNS = [
  "UAL123", "DAL456", "SWA2140", "JBU811", "AAL77", "ASA331", "SKW5412", "FDX1207",
  "UPS2931", "NKS604", "FFT1450", "N345AB", "HAL12", "ENY3301", "UAL1885", "QXE2290",
];
const TYPES = ["B738", "A321", "B737", "A320", "B77W", "E175", "CRJ9", "B763", "A21N", "C172", "B739", "A319"];

// Deterministic PRNG so every mock load looks the same.
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

interface SimAc {
  hex: string;
  callsign: string;
  typeCode: string;
  lat: number;
  lon: number;
  altFt: number;
  vertRateFpm: number;
  gsKt: number;
  trackTrueDeg: number;
  history: Position[];
}

let airport: Airport | null = params.get("empty") === "1" ? null : AIRPORTS[0]!;
let sims: SimAc[] = [];
let handoffs: Handoff[] = [];
let conflicts: ConflictAlert[] = [];
let feed: FeedItem[] = [];
let alerts: AlertItem[] = [];
const aircraftStates = new Map<string, AircraftActorState>();

function spawn(i: number, ap: Airport): SimAc {
  const brg = rand() * 360;
  const dist = 6 + rand() * (RADIUS - 10);
  const p = destination(ap.lat, ap.lon, brg, dist);
  const climbing = rand() > 0.55;
  const descending = !climbing && rand() > 0.4;
  return {
    hex: (0xa10000 + i * 4099).toString(16),
    callsign: CALLSIGNS[i % CALLSIGNS.length]!,
    typeCode: TYPES[i % TYPES.length]!,
    lat: p.lat,
    lon: p.lon,
    altFt: Math.round((3000 + rand() * 28000) / 100) * 100,
    vertRateFpm: climbing ? 1200 + Math.round(rand() * 1500) : descending ? -(800 + Math.round(rand() * 1400)) : Math.round((rand() - 0.5) * 200),
    gsKt: 180 + Math.round(rand() * 280),
    trackTrueDeg: Math.round(rand() * 360),
    history: [],
  };
}

function resetWorld(ap: Airport | null) {
  seed = 42;
  sims = [];
  handoffs = [];
  conflicts = [];
  alerts = [];
  aircraftStates.clear();
  if (!ap) return;
  sims = CALLSIGNS.map((_, i) => spawn(i, ap));
  // Cross-sector conflict pair converging on the boundary.
  const north = sims[0]!;
  const south = sims[1]!;
  Object.assign(north, { ...destination(ap.lat, ap.lon, 300, 9), altFt: 8000, vertRateFpm: 0, trackTrueDeg: 160, gsKt: 250 });
  Object.assign(south, { ...destination(ap.lat, ap.lon, 235, 8), altFt: 8400, vertRateFpm: -600, trackTrueDeg: 20, gsKt: 240 });
  // Climbing aircraft with a contradicting clearance (non-conforming demo).
  const swa = sims[2]!;
  Object.assign(swa, { ...destination(ap.lat, ap.lon, 160, 14), altFt: 7800, vertRateFpm: 1800, trackTrueDeg: 140, gsKt: 280 });
  // Aircraft about to cross the boundary with a pending handoff.
  const jbu = sims[3]!;
  Object.assign(jbu, { ...destination(ap.lat, ap.lon, 80, 16), lat: ap.lat + 0.03, altFt: 11000, vertRateFpm: -1200, trackTrueDeg: 185, gsKt: 290 });
  const now = Date.now();
  handoffs = [{ hex: jbu.hex, callsign: jbu.callsign, from: "NORTH", to: "SOUTH", startedAt: now, dueAt: now + 30000, state: "pending" }];
  conflicts = [
    {
      id: `${north.callsign}-${south.callsign}`, a: north.callsign, b: south.callsign, hexA: north.hex, hexB: south.hex,
      sectors: ["NORTH", "SOUTH"], predictedLatNm: 1.8, predictedVertFt: 400, inSec: 70, state: "coordinating",
      raisedAt: now - 8000, dueAt: now + 22000,
    },
  ];
  aircraftStates.set(swa.hex, {
    callsign: swa.callsign,
    clearance: mkClearance("altitude", 4000, undefined, "CIC", "Southwest twenty-one forty, descend and maintain four thousand."),
    track: [],
    status: "non_conforming",
    statusReason: "Cleared to 4,000. Now 7,800 and climbing 1,800 fpm.",
  });
  aircraftStates.set(north.hex, {
    callsign: north.callsign,
    clearance: mkClearance("altitude", 8000, undefined, "NORTH", "United one twenty-three, maintain eight thousand."),
    track: [],
    status: "conforming",
    statusReason: "Level at 8,000 as cleared.",
  });
  // Pre-roll a minute of history without moving the aircraft: step back 60 s, then forward in 5 s steps.
  for (const s of sims) {
    const start = { lat: s.lat, lon: s.lon, altFt: s.altFt, vertRateFpm: s.vertRateFpm };
    const back = destination(s.lat, s.lon, (s.trackTrueDeg + 180) % 360, (s.gsKt / 3600) * 60);
    Object.assign(s, { lat: back.lat, lon: back.lon, altFt: s.altFt - s.vertRateFpm, history: [] });
    for (let k = 0; k < 12; k++) advance(s, 5, (k - 11) * 5000);
    Object.assign(s, start);
  }
  feed = [
    ...feed,
    item("RADAR", "#radar", `SESSION ${ap.icao} (${ap.name}) started, radius ${RADIUS} NM`, -60000),
    item("RADAR", "#radar", `NONCONF ${swa.callsign} cleared 040, now 078 climbing 1,800 fpm (owner SOUTH)`, -40000),
    item("MONITOR", "#alerts", `${swa.callsign} was cleared to descend to 4,000 but is climbing through 7,800 at 1,800 fpm. It is moving away from its cleared altitude.`, -38000),
    item("MONITOR", "SOUTH", `NONCONF ${swa.callsign}: cleared 040, now 078 climbing. Your aircraft.`, -37000),
    item("SOUTH", "#alerts", `${swa.callsign}: reissue descent clearance, advise CIC.`, -36000),
    item("RADAR", "#radar", `CA ${north.callsign}/${south.callsign} predicted 1.8 NM / 400 FT in 70 s (NORTH/SOUTH)`, -9000),
    item("NORTH", "SOUTH", "APREQ, Delta four fifty-six, turn left heading two seven zero for traffic United one twenty-three.", -6000),
    item("RADAR", "#radar", `BOUNDARY ${jbu.callsign} NORTH->SOUTH in 1.8 NM, 110 descending`, -3000),
    item("NORTH", "SOUTH", "Handoff, JetBlue eight eleven, one one thousand descending, two miles north of the line.", -2000),
  ];
  alerts = [{ ts: now - 40000, kind: "NONCONF", text: `${swa.callsign} non-conforming: cleared 4,000, climbing through 7,800.` }];
}

function mkClearance(kind: "altitude" | "heading", value: number, turn: "left" | "right" | undefined, by: string, phraseology: string): Clearance {
  const now = Date.now();
  return {
    kind, value, ...(turn ? { turn } : {}), issuedAt: now - 30000,
    graceUntil: now - 10000, deadlineAt: now + 30000, issuedBy: by, phraseology,
  };
}

function item(from: string, to: string, text: string, dt = 0): FeedItem {
  return { ts: Date.now() + dt, from, to, text };
}

function advance(s: SimAc, dtSec: number, tsOffsetMs = 0) {
  if (!airport) return;
  const p = destination(s.lat, s.lon, s.trackTrueDeg, (s.gsKt / 3600) * dtSec);
  s.lat = p.lat;
  s.lon = p.lon;
  s.altFt = Math.max(1500, Math.min(41000, s.altFt + (s.vertRateFpm / 60) * dtSec));
  if (s.altFt >= 41000 || s.altFt <= 1500) s.vertRateFpm = 0;
  if (haversineNm(airport.lat, airport.lon, s.lat, s.lon) > RADIUS - 1) {
    // Re-enter from the opposite side, flying inbound.
    const back = destination(airport.lat, airport.lon, (s.trackTrueDeg + 180) % 360, RADIUS - 3);
    s.lat = back.lat;
    s.lon = back.lon;
  }
  const pos: Position = {
    hex: s.hex, callsign: s.callsign, registration: null, typeCode: s.typeCode, lat: s.lat, lon: s.lon,
    altFt: Math.round(s.altFt / 25) * 25, gsKt: s.gsKt, trackTrueDeg: s.trackTrueDeg, vertRateFpm: s.vertRateFpm,
    seenSec: 1, ts: Date.now() + tsOffsetMs,
  };
  s.history = [...s.history.slice(-23), pos];
}

function trackControl(): Record<string, Sector> {
  const tc: Record<string, Sector> = {};
  if (!airport) return tc;
  for (const s of sims) tc[s.hex] = sectorOf(s.lat, airport);
  for (const h of handoffs) if (h.state === "pending") tc[h.hex] = h.from;
  return tc;
}

function traffic(): TrafficEntry[] {
  if (!airport) return [];
  const tc = trackControl();
  const inCa = new Set(conflicts.filter((c) => c.state !== "resolved").flatMap((c) => [c.hexA, c.hexB]));
  return sims.map((s, i) => {
    const st = aircraftStates.get(s.hex);
    const coasting = i === 9;
    return {
      hex: s.hex, callsign: s.callsign, typeCode: s.typeCode, lat: s.lat, lon: s.lon,
      altFt: Math.round(s.altFt / 25) * 25, vertRateFpm: s.vertRateFpm, gsKt: s.gsKt, trackTrueDeg: s.trackTrueDeg,
      status: (coasting ? "coasting" : (st?.status ?? "none")) as Status,
      sector: tc[s.hex] ?? null, ca: inCa.has(s.hex), ts: Date.now(), seenSec: coasting ? 34 : 1,
    };
  });
}

function airspaceState(): AirspaceState {
  return { airport, traffic: traffic(), trackControl: trackControl(), handoffs, conflicts, feed: feed.slice(-100), alerts: alerts.slice(-20) };
}

// ---- fake sockets ----------------------------------------------------------

interface MockSub {
  actor: ActorName;
  id: string;
  sock: MockSocket;
}
const subs = new Set<MockSub>();
let version = 0;

class MockSocket implements SocketLike {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  send(msg: unknown) {
    if (this.closed) return;
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
  close() {
    this.closed = true;
    for (const s of subs) if (s.sock === this) subs.delete(s);
  }
}

function aircraftSnapshot(hex: string): AircraftActorState | null {
  const st = aircraftStates.get(hex);
  if (!st) return null;
  const sim = sims.find((s) => s.hex === hex);
  return { ...st, track: sim?.history ?? [] };
}

function emitAirspace(fields: (keyof AirspaceState)[]) {
  const full = airspaceState();
  const changes: Record<string, unknown> = {};
  for (const f of fields) changes[f] = full[f];
  version++;
  for (const s of subs) if (s.actor === "Airspace") s.sock.send({ type: "state_update", changes, removed: [], version });
}

function emitAircraft() {
  for (const s of subs) {
    if (s.actor !== "Aircraft") continue;
    const snap = aircraftSnapshot(s.id);
    if (snap) s.sock.send({ type: "state_update", changes: snap, removed: [], version: ++version });
  }
}

export function openSocket(url: string): SocketLike {
  const [actor, id] = url.replace("mock://", "").split("/") as [ActorName, string];
  const sock = new MockSocket();
  subs.add({ actor, id, sock });
  setTimeout(() => {
    if (actor === "Airspace") sock.send({ type: "state", state: airspaceState(), version });
    else {
      const snap = aircraftSnapshot(id);
      if (snap) sock.send({ type: "state", state: snap, version });
    }
  }, 50);
  return sock;
}

// ---- simulation loop -------------------------------------------------------

const SCRIPT: [string, string, string][] = [
  ["SOUTH", "NORTH", "Delta four fifty-six, left heading two seven zero, approved."],
  ["NORTH", "#coord", "Plan: Delta four fifty-six turn left heading two seven zero for United one twenty-three. Resolved."],
  ["SOUTH", "NORTH", "JetBlue eight eleven, radar contact."],
  ["SOUTH", "#cic", "Unable, Alaska three thirty-one to eight thousand, traffic FedEx twelve zero seven, eight thousand, two miles ahead. Suggest seven thousand."],
  ["MONITOR", "#alerts", "Southwest twenty-one forty remains non-conforming. It is still climbing away from four thousand."],
  ["CIC", "#cic", "SOUTH, hold handoffs for two minutes."],
  ["SOUTH", "#cic", "SOUTH, holding handoffs for two minutes."],
];
let scriptIdx = 0;
let tickN = 0;
const TICK_MS = 2000;

function tick() {
  if (!airport) return;
  tickN++;
  for (const s of sims) advance(s, TICK_MS / 1000);
  const fields: (keyof AirspaceState)[] = ["traffic", "trackControl"];
  if (tickN % 5 === 0) {
    const [from, to, text] = SCRIPT[scriptIdx % SCRIPT.length]!;
    scriptIdx++;
    feed = [...feed, item(from, to, text)].slice(-100);
    fields.push("feed");
    if (text.includes("radar contact")) {
      handoffs = handoffs.map((h) => (h.state === "pending" ? { ...h, state: "accepted" } : h));
      fields.push("handoffs");
    }
    if (text.includes("Resolved")) {
      conflicts = conflicts.map((c) => ({ ...c, state: "resolved", resolution: "DAL456 left heading 270" }));
      fields.push("conflicts");
    }
  }
  if (tickN % 30 === 0) {
    resetScenarioBits();
    fields.push("handoffs", "conflicts");
  }
  emitAirspace(fields);
  emitAircraft();
}

function resetScenarioBits() {
  const now = Date.now();
  handoffs = handoffs.map((h) => ({ ...h, state: "pending", startedAt: now, dueAt: now + 30000 }));
  conflicts = conflicts.map((c) => ({ ...c, state: "active", resolution: undefined, raisedAt: now, dueAt: now + 30000 }));
  alerts = [...alerts, { ts: now, kind: "CA" as const, text: "CA UAL123/DAL456 predicted 1.8 NM / 400 FT in 70 s" }].slice(-20);
}

if (params.get("mock") === "1") {
  resetWorld(airport);
  setInterval(tick, TICK_MS);
}

// ---- HTTP fakes -------------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getConfig(): Promise<BridgeConfig> {
  return { dataSource: params.get("replay") === "1" ? "replay" : "live", radiusNm: RADIUS, relayObserverUrl: "https://agentrelay.com/observer" };
}

export async function lookupAirport(code: string): Promise<AirportLookup> {
  await wait(120);
  const c = code.trim().toUpperCase();
  const hit = AIRPORTS.find((a) => a.icao === c || a.icao === `K${c}`);
  if (hit) return { ok: true, airport: hit };
  const suggestions = AIRPORTS.filter((a) => a.icao.startsWith(c.slice(0, 2)) || a.icao.startsWith(`K${c.slice(0, 1)}`))
    .slice(0, 5)
    .map((a) => ({ icao: a.icao, name: a.name, city: a.city }));
  return { ok: false, error: `No US airport matches "${c}".`, suggestions };
}

export async function startSession(code: string): Promise<{ airport?: Airport; error?: string }> {
  const r = await lookupAirport(code);
  if (!r.ok) return { error: r.error };
  airport = r.airport;
  feed = [...feed, item("RADAR", "#radar", `Now controlling ${airport.icao} (${airport.name})`)];
  resetWorld(airport);
  version++;
  for (const s of subs) if (s.actor === "Airspace") s.sock.send({ type: "state", state: airspaceState(), version });
  return { airport };
}

export async function postCic(text: string): Promise<boolean> {
  feed = [...feed, item("CIC", "#cic", text)];
  emitAirspace(["feed"]);
  return true;
}

export async function getGrant(actor: ActorName, id: string): Promise<Grant> {
  await wait(30);
  if (actor === "Aircraft" && !aircraftStates.has(id)) throw new Error("no actor");
  return { websocketUrl: `mock://${actor}/${id}`, connectByMs: Date.now() + 30000 };
}

const WORDS: Record<string, string> = { "2000": "two thousand", "3000": "three thousand", "4000": "four thousand", "5000": "five thousand", "6000": "six thousand", "7000": "seven thousand", "8000": "eight thousand", "9000": "niner thousand", "10000": "one zero thousand", "11000": "one one thousand", "12000": "one two thousand" };

export async function sendClearance(text: string, override: boolean): Promise<ClearanceResponse> {
  await wait(900);
  const up = text.toUpperCase().replace(/\s+/g, "");
  const sim = sims.find((s) => up.includes(s.callsign)) ?? (/UNITED/i.test(text) ? sims[0] : /SOUTHWEST/i.test(text) ? sims[2] : undefined);
  if (!sim || !airport) {
    return {
      issued: false, transcript: text, sayAgain: true, reason: "Say again. Callsign not recognized.",
      suggestions: sims.slice(0, 3).map((s) => s.callsign),
      steps: [{ id: "parse", status: "ok", detail: "parsed", ms: 410 }, { id: "resolve", status: "fail", detail: "no matching callsign", ms: 2 }],
    };
  }
  const hdg = /heading\s+(\d{1,3})/i.exec(text);
  const fl = /flight level\s+(\d{2,3})/i.exec(text);
  const num = /(\d{1,2},?\d{3})/.exec(text.replace(new RegExp(sim.callsign, "i"), ""));
  const kind: "altitude" | "heading" = hdg ? "heading" : "altitude";
  const value = hdg ? Number(hdg[1]) : fl ? Number(fl[1]) * 100 : num ? Number(num[1]!.replace(",", "")) : 7000;
  const turn: "left" | "right" | undefined = hdg ? (/left/i.test(text) ? "left" : "right") : undefined;
  const climb = value > sim.altFt;
  const phraseology =
    kind === "heading"
      ? `${sim.callsign}, turn ${turn} heading ${String(value).padStart(3, "0")}.`
      : `${sim.callsign}, ${climb ? "climb" : "descend"} and maintain ${WORDS[String(value)] ?? value.toLocaleString("en-US")}.`;
  const sector = trackControl()[sim.hex] ?? "NORTH";
  const unsafe = kind === "altitude" && value % 2000 === 0;
  const parsed = { callsign: sim.callsign, kind, value, ...(turn ? { turn } : {}) } as const;
  const probe = unsafe
    ? {
        ok: false,
        reasons: [`Conflict with ${sims[5]!.callsign}: 1.2 NM / 300 ft in 55 s.`],
        conflicts: [{ with: sims[5]!.callsign, minLatNm: 1.2, minVertFt: 300, inSec: 55 }],
        alternative: { kind: "altitude" as const, value: value - 1000 },
      }
    : { ok: true, reasons: [], conflicts: [] };
  const steps: ClearanceResponse["steps"] = [
    { id: "parse", status: "ok", detail: `${sim.callsign} ${kind} ${value}`, ms: 480 },
    { id: "resolve", status: "ok", detail: `${sim.hex} owned by ${sector}`, ms: 3 },
    { id: "probe", status: probe.ok ? "ok" : "fail", detail: probe.ok ? "no conflicts in 120 s" : probe.reasons[0]!, ms: 6 },
    { id: "sectorReview", status: override ? "skipped" : probe.ok ? "ok" : "fail", detail: override ? "CIC override" : probe.ok ? `${sector} issued` : `${sector}: unable`, ms: override ? 0 : 1650 },
    { id: "issue", status: unsafe && !override ? "skipped" : "ok", detail: unsafe && !override ? "not issued" : "Aircraft actor updated", ms: 12 },
  ];
  if (unsafe && !override) {
    const altWords = WORDS[String(value - 1000)] ?? String(value - 1000);
    const reason = `Unable, ${sim.callsign} to ${WORDS[String(value)] ?? value}, traffic ${sims[5]!.callsign}, ${WORDS[String(value)] ?? value}, two miles ahead. Suggest ${altWords}.`;
    feed = [...feed, item(sector, "#cic", reason)];
    emitAirspace(["feed"]);
    return {
      issued: false, transcript: text, parsed, hex: sim.hex, sector, phraseology, probe, reason,
      alternative: { kind: "altitude", value: value - 1000, text: `${sim.callsign}, ${climb ? "climb" : "descend"} and maintain ${value - 1000}` },
      steps,
    };
  }
  aircraftStates.set(sim.hex, {
    callsign: sim.callsign,
    clearance: { ...mkClearance(kind, value, turn, override ? "CIC" : sector, phraseology), issuedAt: Date.now(), graceUntil: Date.now() + 20000, deadlineAt: Date.now() + 60000 },
    track: [],
    status: "pending",
    statusReason: "Clearance issued. Waiting for the aircraft to respond.",
  });
  setTimeout(() => {
    const st = aircraftStates.get(sim.hex);
    if (!st) return;
    const toward = kind === "heading" || (value > sim.altFt ? sim.vertRateFpm > 500 : sim.vertRateFpm < -500);
    aircraftStates.set(sim.hex, {
      ...st,
      status: toward ? "conforming" : "non_conforming",
      statusReason: toward
        ? `Cleared to ${value.toLocaleString("en-US")}. Now ${Math.round(sim.altFt).toLocaleString("en-US")} and moving toward it.`
        : `Cleared to ${value.toLocaleString("en-US")}. Now ${Math.round(sim.altFt).toLocaleString("en-US")} and ${sim.vertRateFpm > 0 ? "climbing" : "descending"} ${Math.abs(sim.vertRateFpm).toLocaleString("en-US")} fpm.`,
    });
    emitAirspace(["traffic"]);
  }, 6000);
  if (override) {
    feed = [...feed, item("CIC", "#cic", `CIC override: ${phraseology}`)];
    alerts = [...alerts, { ts: Date.now(), kind: "OVERRIDE" as const, text: `CIC override issued: ${phraseology}` }];
    emitAirspace(["feed", "alerts"]);
  }
  return { issued: true, transcript: text, parsed, hex: sim.hex, sector, phraseology, probe, override, steps };
}
