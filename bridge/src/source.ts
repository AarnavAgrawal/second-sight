// ADS-B data sources: live (adsb.lol + recorder) and replay (newest recording for the airport, real speed, looped).
import { appendFile, mkdir, readdir } from "node:fs/promises";
import type { Airport } from "../../shared/types.ts";
import { config, repoPath } from "./config.ts";
import { applyScenario, loadScenario, type Scenario } from "./scenario.ts";

export interface Snapshot {
  /** Epoch ms when the snapshot was taken (replay: rewritten to wall-clock now). */
  ts: number;
  ac: Record<string, unknown>[];
}

export interface Source {
  readonly kind: "live" | "replay";
  next(): Promise<Snapshot>;
  close(): void;
}

// Fields we keep from each aircraft (keeps recordings small: ~200 bytes per aircraft).
const KEEP = ["hex", "flight", "r", "t", "lat", "lon", "alt_baro", "gs", "track", "true_heading", "baro_rate", "geom_rate", "seen", "seen_pos", "squawk"];
const trim = (a: Record<string, unknown>) => {
  const o: Record<string, unknown> = {};
  for (const k of KEEP) if (a[k] !== undefined) o[k] = a[k];
  return o;
};

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export class LiveSource implements Source {
  readonly kind = "live" as const;
  private file: string;
  private dirReady: Promise<unknown>;
  constructor(private airport: Airport) {
    const dir = repoPath(`data/recordings/${airport.icao}`);
    this.dirReady = mkdir(dir, { recursive: true });
    this.file = `${dir}/${stamp()}.jsonl`;
  }
  async next(): Promise<Snapshot> {
    const { lat, lon, radiusNm } = this.airport;
    const url = `${config.adsbBase}/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(radiusNm)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "second-sight-hackathon" } });
    if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);
    const body = (await res.json()) as { ac?: Record<string, unknown>[] };
    const snap: Snapshot = { ts: Date.now(), ac: (body.ac ?? []).map(trim) };
    await this.dirReady;
    appendFile(this.file, JSON.stringify(snap) + "\n").catch((e) => console.error("[recorder]", e.message));
    return snap;
  }
  close() {}
}

export class ReplaySource implements Source {
  readonly kind = "replay" as const;
  private startWall = Date.now();
  private constructor(
    private lines: Snapshot[],
    readonly file: string,
    private scenario: Scenario | null,
    private airport: Airport,
  ) {}

  static async open(airport: Airport): Promise<ReplaySource | { error: string }> {
    const dir = repoPath(`data/recordings/${airport.icao}`);
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      /* no dir */
    }
    const scenario = await loadScenario(airport.icao);
    const pick = scenario?.recording && files.includes(scenario.recording) ? scenario.recording : files.at(-1);
    if (!pick) return { error: `No recording for ${airport.icao}. Run in live mode first to record traffic.` };
    const text = await Bun.file(`${dir}/${pick}`).text();
    let lines = text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Snapshot;
        } catch {
          return null;
        }
      })
      .filter((x): x is Snapshot => !!x && Array.isArray(x.ac));
    if (scenario?.startOffsetSec || scenario?.durationSec) {
      const t0 = lines[0]?.ts ?? 0;
      const from = t0 + (scenario.startOffsetSec ?? 0) * 1000;
      const to = scenario.durationSec ? from + scenario.durationSec * 1000 : Infinity;
      lines = lines.filter((l) => l.ts >= from && l.ts <= to);
    }
    if (lines.length < 2) return { error: `Recording ${pick} for ${airport.icao} is too short to replay.` };
    console.log(`[replay] ${airport.icao} ${pick}: ${lines.length} snapshots${scenario ? " + scenario" : ""}`);
    return new ReplaySource(lines, pick, scenario, airport);
  }

  /** Seconds since replay start, looped over the recording length. */
  elapsedSec(): number {
    const t0 = this.lines[0]!.ts;
    const dur = this.lines.at(-1)!.ts - t0 + config.pollMs;
    return ((Date.now() - this.startWall) % dur) / 1000;
  }

  async next(): Promise<Snapshot> {
    const t0 = this.lines[0]!.ts;
    const off = this.elapsedSec() * 1000;
    let line = this.lines[0]!;
    for (const l of this.lines) {
      if (l.ts - t0 <= off) line = l;
      else break;
    }
    const ac = this.scenario ? applyScenario(this.scenario, line.ac, this.elapsedSec(), this.airport) : line.ac;
    return { ts: Date.now(), ac };
  }
  close() {}
}
