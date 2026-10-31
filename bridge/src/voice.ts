// Deepgram voice adapter (CLAUDE.md section 10): Nova-3 pre-recorded speech-to-text with keyterm
// prompting, and Aura-2 text-to-speech for sector controller replies. Plain fetch, no SDK.
// The API key stays on the bridge; the browser only ever talks to /transcribe and /speak.
//
// Deepgram limits (verified against developers.deepgram.com, Oct 2026):
// - keyterm: Nova-3 only, repeat `keyterm=` per term, multi-word phrases allowed (space -> `+` or `%20`).
//   No fixed count limit; the hard limit is 500 tokens across all keyterms per request
//   ("Keyterm limit exceeded"). Docs recommend the 20-50 most important terms.
// - Aura-2 REST /v1/speak: JSON body { text }, max 2000 characters (413 above that). Default output is MP3.

import { haversineNm } from "../../shared/geo.ts";
import { airlinePrefix, spokenCallsign, TELEPHONY } from "../../shared/telephony.ts";

const DG_BASE = "https://api.deepgram.com/v1";

/** We cap at 100 keyterms (CLAUDE.md) and at a conservative token estimate under Deepgram's 500-token limit. */
export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_TOKENS = 450;
export const TTS_MAX_CHARS = 2000;

/** ATC phrases first: they anchor the parse ("climb and maintain" vs "climb maintain"). */
export const ATC_KEYTERMS = [
  "climb and maintain",
  "descend and maintain",
  "maintain",
  "flight level",
  "turn left heading",
  "turn right heading",
  "fly heading",
  "thousand",
  "radar contact",
];

const DEFAULT_VOICE = "aura-2-thalia-en"; // clear, confident (feminine)
const DEFAULT_VOICE_SOUTH = "aura-2-orion-en"; // calm, polite (masculine)
const DEFAULT_VOICE_MONITOR = "aura-2-athena-en"; // calm, smooth, professional (feminine)

function apiKey(): string {
  return (process.env.DEEPGRAM_API_KEY ?? "").trim();
}

export function voiceConfigured(): boolean {
  return apiKey().length > 0;
}

/**
 * Rough token estimate for a keyterm. Deepgram does not publish its tokenizer, so this deliberately
 * over-counts (about 4 characters per token per word, hyphenated parts counted separately).
 */
export function estimateKeytermTokens(term: string): number {
  return term
    .split(/[\s-]+/)
    .filter(Boolean)
    .reduce((n, w) => n + Math.max(1, Math.ceil(w.length / 4)), 0);
}

type KeytermTraffic = { hex: string; callsign: string; lat: number; lon: number; status: string };

/**
 * Build Nova-3 keyterms in priority order, max 100: ATC phrases, then telephony designators of airlines
 * in range, then spoken callsigns (selected hex first, then aircraft with active clearances, then the
 * rest by distance from the airport).
 */
export function buildKeyterms(input: {
  traffic: KeytermTraffic[];
  airport: { lat: number; lon: number } | null;
  selectedHex?: string | null;
}): string[] {
  const { airport, selectedHex } = input;
  const traffic = input.traffic.filter((t) => t.callsign && t.callsign.trim().length > 0);

  const dist = (t: KeytermTraffic) => (airport ? haversineNm(airport.lat, airport.lon, t.lat, t.lon) : 0);
  const rank = (t: KeytermTraffic) => {
    if (selectedHex && t.hex.toLowerCase() === selectedHex.toLowerCase()) return 0;
    if (t.status && t.status !== "none") return 1; // active clearance
    return 2;
  };
  const ordered = traffic
    .map((t) => ({ t, r: rank(t), d: dist(t) }))
    .sort((a, b) => a.r - b.r || a.d - b.d)
    .map((x) => x.t);

  const designators: string[] = [];
  for (const t of ordered) {
    const p = airlinePrefix(t.callsign);
    const tel = p ? TELEPHONY[p] : undefined;
    if (tel) designators.push(tel);
  }
  const callsigns = ordered.map((t) => spokenCallsign(t.callsign));

  const out: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const raw of [...ATC_KEYTERMS, ...designators, ...callsigns]) {
    const term = raw.trim().replace(/\s+/g, " ");
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    const cost = estimateKeytermTokens(term);
    if (tokens + cost > MAX_KEYTERM_TOKENS) continue; // a shorter term later may still fit
    seen.add(key);
    out.push(term);
    tokens += cost;
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

function listenUrl(keyterms: string[]): string {
  const q = new URLSearchParams({ model: "nova-3", smart_format: "true", language: "en" });
  for (const k of keyterms) q.append("keyterm", k); // URLSearchParams encodes spaces as "+", which Deepgram accepts
  return `${DG_BASE}/listen?${q.toString()}`;
}

async function postListen(audio: ArrayBuffer, contentType: string, keyterms: string[]): Promise<Response> {
  return fetch(listenUrl(keyterms), {
    method: "POST",
    headers: { Authorization: `Token ${apiKey()}`, "Content-Type": contentType },
    body: audio,
    signal: AbortSignal.timeout(15_000),
  });
}

/** Nova-3 pre-recorded transcription. Throws on missing key or a Deepgram error. */
export async function transcribe(
  audio: ArrayBuffer,
  contentType: string,
  keyterms: string[],
): Promise<{ transcript: string; confidence: number | null; ms: number }> {
  if (!voiceConfigured()) throw new Error("Deepgram is not configured (DEEPGRAM_API_KEY is empty).");
  if (!audio || audio.byteLength === 0) throw new Error("Empty audio.");
  // MediaRecorder types look like "audio/webm;codecs=opus"; Deepgram sniffs the container, keep the base type.
  const ct = (contentType || "application/octet-stream").split(";")[0]!.trim() || "application/octet-stream";
  const started = Date.now();

  let res = await postListen(audio, ct, keyterms);
  if (res.status === 400 && keyterms.length > 25) {
    const body = await res.text();
    if (/keyterm/i.test(body)) res = await postListen(audio, ct, keyterms.slice(0, 25)); // our token estimate was too low
    else throw new Error(`Deepgram listen failed (400): ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`Deepgram listen failed (${res.status}): ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] };
  };
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  return {
    transcript: (alt?.transcript ?? "").trim(),
    confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
    ms: Date.now() - started,
  };
}

/** Map a sector / identity (or an explicit "aura-2-..." model name) to an Aura-2 voice model. */
export function voiceModel(voice?: string): string {
  const v = (voice ?? "").trim();
  if (/^aura-/i.test(v)) return v;
  const env = (name: string) => (process.env[name] ?? "").trim();
  switch (v.toUpperCase()) {
    case "SOUTH":
      return env("DEEPGRAM_TTS_VOICE_SOUTH") || DEFAULT_VOICE_SOUTH;
    case "MONITOR":
      return env("DEEPGRAM_TTS_VOICE_MONITOR") || DEFAULT_VOICE_MONITOR;
    default:
      return env("DEEPGRAM_TTS_VOICE") || DEFAULT_VOICE;
  }
}

/** Clamp to Deepgram's 2000-character limit, cutting at a word boundary. */
export function clampTtsText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= TTS_MAX_CHARS) return t;
  const cut = t.slice(0, TTS_MAX_CHARS);
  const sp = cut.lastIndexOf(" ");
  return sp > TTS_MAX_CHARS * 0.8 ? cut.slice(0, sp) : cut;
}

type Clip = { audio: ArrayBuffer; contentType: string };
const CACHE_MAX = 200;
const cache = new Map<string, Clip>(); // insertion order = LRU order
const inflight = new Map<string, Promise<Clip>>();

function cacheGet(key: string): Clip | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cachePut(key: string, clip: Clip) {
  cache.set(key, clip);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/**
 * Aura-2 TTS. voice: "NORTH" | "SOUTH" | "MONITOR" | undefined maps to env DEEPGRAM_TTS_VOICE (default
 * aura-2-thalia-en), DEEPGRAM_TTS_VOICE_SOUTH for SOUTH (default aura-2-orion-en), DEEPGRAM_TTS_VOICE_MONITOR
 * for MONITOR (default aura-2-athena-en). Returns mp3 bytes. Cached by (voice, text), LRU 200 entries.
 */
export async function speak(
  text: string,
  voice?: string,
): Promise<{ audio: ArrayBuffer; contentType: string; cached: boolean }> {
  const clean = clampTtsText(text);
  if (!clean) throw new Error("Empty text.");
  const model = voiceModel(voice);
  const key = `${model}\n${clean}`;

  const hit = cacheGet(key);
  if (hit) return { audio: hit.audio.slice(0), contentType: hit.contentType, cached: true }; // copy: callers may transfer it
  if (!voiceConfigured()) throw new Error("Deepgram is not configured (DEEPGRAM_API_KEY is empty).");

  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${DG_BASE}/speak?model=${encodeURIComponent(model)}`, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Deepgram speak failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const clip: Clip = {
        audio: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") || "audio/mpeg",
      };
      cachePut(key, clip);
      return clip;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const clip = await p;
  return { audio: clip.audio.slice(0), contentType: clip.contentType, cached: false };
}
