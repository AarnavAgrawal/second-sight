// Runs INSIDE the Superserve sandbox (plain Node, no deps; needs ffmpeg).
// Splits one ATC recording into transmissions at the squelch silences, transcribes each with OpenAI,
// and appends one JSON line per transmission. Resumable: segments already in the output are skipped.
//
//   node transcribe.mjs <audio.mp3> <startEpochMs> <feed> <out.jsonl> [prompt.txt]
//
// OPENAI_API_KEY is a Superserve stand-in token; the platform swaps in the real key on the way to api.openai.com.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [audio, startArg, feed, out, promptFile] = process.argv.slice(2);
if (!audio || !startArg || !feed || !out) {
  console.error("usage: node transcribe.mjs <audio> <startEpochMs> <feed> <out.jsonl> [prompt.txt]");
  process.exit(2);
}
const startMs = Number(startArg);
const MODEL = process.env.STT_MODEL || "gpt-4o-transcribe";
const NOISE_DB = process.env.SILENCE_DB || "-35dB";
const MIN_SILENCE_S = Number(process.env.MIN_SILENCE_S || 0.6);
const MIN_SPEECH_S = 0.8;
const MAX_SPEECH_S = 30;
const CONCURRENCY = Number(process.env.STT_CONCURRENCY || 6);
const prompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8").trim() : "";
const base = audio.split("/").pop();

function run(cmd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const outChunks = [];
    let err = "";
    p.stdout.on("data", (d) => outChunks.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const stdout = Buffer.concat(outChunks);
      code === 0 ? resolve({ stdout: binary ? stdout : stdout.toString(), stderr: err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

/** Speech spans in [from, to) = the gaps between silences ffmpeg reports. */
async function speechSpans(from, to, noise, minSilence) {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats", "-ss", from.toFixed(2), "-t", (to - from).toFixed(2), "-i", audio,
    "-af", `silencedetect=noise=${noise}:d=${minSilence}`, "-f", "null", "-",
  ]);
  const silences = [];
  let s = null;
  for (const line of stderr.split("\n")) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (a) s = Math.max(0, Number(a[1]));
    if (b) silences.push([s ?? 0, Number(b[1])]), (s = null);
  }
  const len = to - from;
  if (s != null) silences.push([s, len]);
  const spans = [];
  let cursor = 0;
  for (const [a, b] of silences) {
    if (a - cursor >= MIN_SPEECH_S) spans.push([from + cursor, from + a]);
    cursor = b;
  }
  if (len - cursor >= MIN_SPEECH_S) spans.push([from + cursor, to]);
  return spans;
}

async function duration() {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio]);
  return Number(stdout.trim());
}

/**
 * Transmissions: first pass splits at 0.3 s squelch gaps; spans still longer than 12 s
 * (back-to-back transmissions) get a finer pass; anything left over MAX_SPEECH_S is cut evenly.
 */
async function segments() {
  const dur = await duration();
  const coarse = await speechSpans(0, dur, NOISE_DB, MIN_SILENCE_S);
  const fine = [];
  for (const [a, b] of coarse) {
    if (b - a <= 12) fine.push([a, b]);
    else fine.push(...(await speechSpans(a, b, "-25dB", 0.15)));
  }
  return fine.flatMap(([a, b]) => {
    const n = Math.ceil((b - a) / MAX_SPEECH_S);
    return Array.from({ length: n }, (_, i) => [a + ((b - a) * i) / n, a + ((b - a) * (i + 1)) / n]);
  });
}

async function transcribe(a, b) {
  const { stdout: wav } = await run(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", a.toFixed(2), "-t", (b - a + 0.3).toFixed(2), "-i", audio, "-ac", "1", "-ar", "16000", "-f", "wav", "-"],
    { binary: true },
  );
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "tx.wav");
  form.append("model", MODEL);
  form.append("language", "en");
  form.append("response_format", "json");
  if (prompt) form.append("prompt", prompt);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (res.ok) return ((await res.json()).text ?? "").trim();
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`transcribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const done = new Set(
  existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : [],
);
const segs = await segments();
const todo = segs.filter(([a]) => !done.has(`${base}@${a.toFixed(2)}`));
console.log(JSON.stringify({ event: "segments", file: base, total: segs.length, todo: todo.length }));

let next = 0;
let ok = 0;
let failed = 0;
async function workerLoop() {
  while (next < todo.length) {
    const [a, b] = todo[next++];
    const id = `${base}@${a.toFixed(2)}`;
    try {
      const text = await transcribe(a, b);
      appendFileSync(
        out,
        JSON.stringify({ id, feed, file: base, offsetSec: +a.toFixed(2), durSec: +(b - a).toFixed(2), ts: Math.round(startMs + a * 1000), text, model: MODEL }) + "\n",
      );
      ok++;
    } catch (e) {
      failed++;
      console.error(JSON.stringify({ event: "error", id, error: String(e.message ?? e) }));
    }
    if ((ok + failed) % 25 === 0) console.log(JSON.stringify({ event: "progress", file: base, ok, failed, of: todo.length }));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
console.log(JSON.stringify({ event: "done", file: base, ok, failed }));
