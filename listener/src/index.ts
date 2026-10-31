// Frequency listener controller. Drives a Superserve sandbox that turns ATC audio into timestamped transmissions.
//   bun run listener backfill <ICAO> [files...]   upload archive MP3s (default: data/recordings/<ICAO>/*.mp3) and start transcription
//   bun run listener status                      progress of the sandbox jobs
//   bun run listener pull <ICAO>                 copy transcripts to data/atc/<ICAO>/transmissions.jsonl
// The sandbox id lives in .superserve-sandbox. The OpenAI key is a Superserve secret: the sandbox only sees a stand-in token.
import { fileURLToPath } from "node:url";
import { Sandbox, Secret } from "@superserve/sdk";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { spokenCallsign } from "../../shared/telephony.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)); // not .pathname: breaks on Windows paths
const ID_FILE = `${ROOT}.superserve-sandbox`;
const SECRET = "second-sight-openai";
const WORK = "/work";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** LiveATC archive names: KSFO-App-28LR-Oct-31-2026-1800Z.mp3 -> { feed: "KSFO-App-28LR", startMs }. */
export function parseArchiveName(name: string): { feed: string; startMs: number } | null {
  const m = /^(.+)-([A-Z][a-z]{2})-(\d{1,2})-(\d{4})-(\d{2})(\d{2})Z\.mp3$/.exec(name);
  if (!m) return null;
  const [, feed, mon, day, year, hh, mm] = m;
  const month = MONTHS.indexOf(mon!);
  if (month < 0) return null;
  return { feed: feed!, startMs: Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm)) };
}

/** Transcription prompt: ATC phrases plus the spoken callsigns seen in the ADS-B recordings for this airport. */
function buildPrompt(icao: string): string {
  const dir = `${ROOT}data/recordings/${icao}`;
  const seen = new Map<string, number>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split("\n")) {
      if (!line) continue;
      for (const a of (JSON.parse(line) as { ac: { flight?: string }[] }).ac) {
        const cs = a.flight?.trim();
        if (cs && /^[A-Z]{3}\d/.test(cs)) seen.set(cs, (seen.get(cs) ?? 0) + 1);
      }
    }
  }
  const callsigns = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([c]) => spokenCallsign(c));
  return [
    "NorCal Approach. San Francisco Tower. climb and maintain, descend and maintain, maintain, flight level,",
    "turn left heading, turn right heading, fly heading, reduce speed, contact, radar contact, expect, cleared visual approach,",
    "cleared ILS runway two eight left, two eight right, traffic, report in sight.",
    callsigns.join(", ") + ".",
  ].join(" ");
}

async function ensureSecret() {
  const existing = await Secret.list().catch(() => []);
  if (existing.some((s) => s.name === SECRET)) return;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing in .env");
  await Secret.create({ name: SECRET, value: key, provider: "openai" });
  console.log(`created Superserve secret ${SECRET} (provider openai)`);
}

async function sandbox(): Promise<Sandbox> {
  if (existsSync(ID_FILE)) {
    try {
      return await Sandbox.connect(readFileSync(ID_FILE, "utf8").trim());
    } catch (e) {
      console.warn(`stored sandbox unavailable (${(e as Error).message}); creating a new one`);
    }
  }
  const sb = await Sandbox.create({ name: "second-sight-listener", timeoutSeconds: 3 * 3600, metadata: { app: "second-sight" } });
  writeFileSync(ID_FILE, sb.id);
  console.log(`created sandbox ${sb.id}`);
  return sb;
}

async function prepare(sb: Sandbox) {
  await ensureSecret();
  await sb.attachSecret("OPENAI_API_KEY", SECRET).catch((e: { statusCode?: number }) => {
    if (e.statusCode !== 409) throw e; // already bound from an earlier run
  });
  const has = await sb.commands.run("command -v ffmpeg");
  if (has.exitCode !== 0) {
    console.log("installing ffmpeg in sandbox...");
    const r = await sb.commands.run(
      "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ffmpeg >/tmp/apt.log 2>&1",
      { timeoutMs: 600_000 },
    );
    if (r.exitCode !== 0) throw new Error(`ffmpeg install failed: ${r.stderr}`);
  }
  await sb.files.write(`${WORK}/transcribe.mjs`, readFileSync(`${ROOT}listener/worker/transcribe.mjs`, "utf8"));
}

async function backfill(icao: string, files: string[]) {
  const dir = `${ROOT}data/recordings/${icao}`;
  const paths = files.length ? files : readdirSync(dir).filter((f) => f.endsWith(".mp3")).sort().map((f) => `${dir}/${f}`);
  const jobs = paths.map((p) => ({ p, name: basename(p), meta: parseArchiveName(basename(p)) }));
  const bad = jobs.filter((j) => !j.meta);
  if (bad.length) throw new Error(`Not LiveATC archive names: ${bad.map((b) => b.name).join(", ")}`);
  if (!jobs.length) throw new Error(`No MP3s in ${dir}`);

  const sb = await sandbox();
  await prepare(sb);
  await sb.files.write(`${WORK}/${icao}/prompt.txt`, buildPrompt(icao));
  for (const j of jobs) {
    console.log(`uploading ${j.name}`);
    await sb.files.write(`${WORK}/${icao}/audio/${j.name}`, readFileSync(j.p), { timeoutMs: 300_000 });
  }
  // One background shell runs the files in order; each file's worker transcribes 6 segments at a time.
  // NODE_USE_ENV_PROXY: Node's fetch ignores HTTPS_PROXY otherwise, and the Superserve proxy is what swaps in the real key.
  const lines = jobs.map(
    (j) =>
      `NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1 SILENCE_DB=-30dB MIN_SILENCE_S=0.3 node ${WORK}/transcribe.mjs ${WORK}/${icao}/audio/${j.name} ${j.meta!.startMs} ${j.meta!.feed} ${WORK}/${icao}/out/${j.name}.jsonl ${WORK}/${icao}/prompt.txt`,
  );
  await sb.files.write(`${WORK}/${icao}/run.sh`, `#!/bin/sh\nmkdir -p ${WORK}/${icao}/out\n${lines.join("\n")}\necho ALL_DONE\n`);
  const r = await sb.commands.run(`cd ${WORK}/${icao} && nohup sh run.sh > run.log 2>&1 & echo started`);
  console.log(r.stdout.trim(), `(${jobs.length} files, sandbox ${sb.id})`);
}

async function status() {
  const sb = await sandbox();
  const r = await sb.commands.run(`for d in ${WORK}/*/; do echo "== $d"; tail -n 4 $d/run.log 2>/dev/null; wc -l $d/out/*.jsonl 2>/dev/null | tail -n 5; done`);
  console.log(r.stdout.trim() || r.stderr.trim());
}

async function pull(icao: string) {
  const sb = await sandbox();
  const r = await sb.commands.run(`cat ${WORK}/${icao}/out/*.jsonl 2>/dev/null`);
  const outDir = `${ROOT}data/atc/${icao}`;
  mkdirSync(outDir, { recursive: true });
  const all = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; file: string; ts: number; text: string });
  all.sort((a, b) => a.ts - b.ts);
  // LiveATC archive files run ~32 min per 30-min slot, so the overlap is transcribed twice: keep the first copy.
  const rows = all.filter((x, i) => !all.slice(Math.max(0, i - 5), i).some((p) => p.file !== x.file && Math.abs(p.ts - x.ts) < 2000));
  const dupes = all.filter((x) => !rows.includes(x)).map((x) => x.id);
  if (dupes.length) writeFileSync(`${ROOT}data/atc/${icao}/duplicates.json`, JSON.stringify(dupes));
  writeFileSync(`${outDir}/transmissions.jsonl`, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`pulled ${rows.length} transmissions (${dupes.length} archive-overlap duplicates dropped) -> data/atc/${icao}/transmissions.jsonl`);
}

const [cmd, icaoArg, ...rest] = process.argv.slice(2);
const icao = (icaoArg ?? "KSFO").toUpperCase();
if (cmd === "backfill") await backfill(icao, rest);
else if (cmd === "status") await status();
else if (cmd === "pull") await pull(icao);
else console.log("usage: bun run listener backfill|status|pull [ICAO] [files...]");
