// Replay-only scenario layer: inject synthetic aircraft (callsign prefixed SIM) or bend a recorded aircraft.
// Never used in live mode (CLAUDE.md: no fake data in live mode).
import { destination } from "../../shared/geo.ts";
import type { Airport } from "../../shared/types.ts";
import { repoPath } from "./config.ts";

export interface ScenarioInject {
  hex: string;
  callsign: string; // must start with SIM
  typeCode?: string;
  startSec: number;
  endSec?: number;
  lat: number;
  lon: number;
  altFt: number;
  gsKt: number;
  trackTrueDeg: number;
  vertRateFpm?: number;
  /** Stop climbing/descending at this altitude. */
  levelOffFt?: number;
  /** Discrete transponder code (defaults to 4 + last 3 hex digits), so SIM traffic is CA-eligible. */
  squawk?: string;
}

export interface ScenarioBend {
  callsign: string;
  fromSec: number;
  toSec?: number;
  /** Altitude at fromSec (defaults to the recorded altitude at fromSec). */
  altFt?: number;
  vertRateFpm?: number;
  levelOffFt?: number;
}

export interface Scenario {
  recording?: string;
  startOffsetSec?: number;
  durationSec?: number;
  inject?: ScenarioInject[];
  bend?: ScenarioBend[];
  /** Replay-only: raise CA/BOUNDARY only for pairs/aircraft involving these callsigns (keeps the demo focused). */
  focusCallsigns?: string[];
  note?: string;
}

export async function loadScenario(icao: string): Promise<Scenario | null> {
  const f = Bun.file(repoPath(`data/recordings/${icao}/scenario.json`));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as Scenario;
  } catch (e) {
    console.error(`[scenario] invalid scenario.json for ${icao}:`, (e as Error).message);
    return null;
  }
}

const climb = (alt: number, rate: number, dtSec: number, levelOff?: number) => {
  const raw = alt + (rate * dtSec) / 60;
  if (levelOff === undefined || rate === 0) return raw;
  return rate > 0 ? Math.min(raw, levelOff) : Math.max(raw, levelOff);
};

const bendBase = new Map<string, number>();

export function applyScenario(s: Scenario, ac: Record<string, unknown>[], tSec: number, _airport: Airport): Record<string, unknown>[] {
  let out = ac;
  if (tSec < 1) bendBase.clear(); // new loop
  for (const b of s.bend ?? []) {
    if (tSec < b.fromSec || (b.toSec !== undefined && tSec > b.toSec)) continue;
    out = out.map((a) => {
      if (String(a.flight ?? "").trim() !== b.callsign) return a;
      const key = `${b.callsign}@${b.fromSec}`;
      if (!bendBase.has(key)) bendBase.set(key, b.altFt ?? (typeof a.alt_baro === "number" ? a.alt_baro : 0));
      const rate = b.vertRateFpm ?? 0;
      const alt = climb(bendBase.get(key)!, rate, tSec - b.fromSec, b.levelOffFt);
      const leveled = b.levelOffFt !== undefined && Math.round(alt) === b.levelOffFt;
      return { ...a, alt_baro: Math.round(alt), baro_rate: leveled ? 0 : rate };
    });
  }
  for (const i of s.inject ?? []) {
    if (tSec < i.startSec || (i.endSec !== undefined && tSec > i.endSec)) continue;
    const dt = tSec - i.startSec;
    const p = destination(i.lat, i.lon, i.trackTrueDeg, (i.gsKt * dt) / 3600);
    const rate = i.vertRateFpm ?? 0;
    const alt = climb(i.altFt, rate, dt, i.levelOffFt);
    const leveled = i.levelOffFt !== undefined && Math.round(alt) === i.levelOffFt;
    out = [
      ...out,
      {
        hex: i.hex,
        flight: i.callsign.padEnd(8, " "),
        t: i.typeCode ?? "B738",
        lat: p.lat,
        lon: p.lon,
        alt_baro: Math.round(alt),
        gs: i.gsKt,
        track: i.trackTrueDeg,
        baro_rate: leveled ? 0 : rate,
        squawk: i.squawk ?? `4${i.hex.slice(-3)}`,
        seen: 0,
        seen_pos: 0,
      },
    ];
  }
  return out;
}
