// Bridge HTTP client. With ?mock=1 in the URL every call goes to the in-browser mock instead.
import type { Airport } from "@shared/types.ts";
import type { ActorName, AirportLookup, AirportSuggestion, BridgeConfig, ClearanceResponse, Grant } from "./apiTypes.ts";
import * as mock from "./mock.ts";

export const MOCK = new URLSearchParams(location.search).get("mock") === "1";
export const BRIDGE_URL: string = (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? "http://localhost:8787";

/** Minimal surface shared by WebSocket and the mock socket. */
export interface SocketLike {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close(): void;
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BRIDGE_URL}${path}`, init);
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text || res.statusText };
  }
  return { status: res.status, body: body as T };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function getConfig(): Promise<BridgeConfig> {
  if (MOCK) return mock.getConfig();
  const { status, body } = await json<BridgeConfig>("/config");
  if (status >= 400) throw new Error(`config ${status}`);
  return body;
}

export async function lookupAirport(code: string): Promise<AirportLookup> {
  if (MOCK) return mock.lookupAirport(code);
  const { body } = await json<Record<string, unknown>>(`/airports/${encodeURIComponent(code)}`);
  if (!body || typeof body !== "object" || body.error || typeof body.icao !== "string") {
    const suggestions = Array.isArray(body?.suggestions) ? (body.suggestions as AirportSuggestion[]) : [];
    return { ok: false, error: String(body?.error ?? "No match"), suggestions };
  }
  return { ok: true, airport: body as unknown as Airport };
}

export async function startSession(code: string): Promise<{ airport?: Airport; error?: string }> {
  if (MOCK) return mock.startSession(code);
  const { status, body } = await json<{ airport?: Airport; error?: string }>("/session", post({ code }));
  if (status >= 400 && !body.error) return { error: `Session failed (${status})` };
  return body;
}

export async function sendClearance(text: string, override = false): Promise<ClearanceResponse> {
  if (MOCK) return mock.sendClearance(text, override);
  const { status, body } = await json<ClearanceResponse>("/clearance", post(override ? { text, override } : { text }));
  if (status >= 400 && !body.steps) {
    return { issued: false, transcript: text, steps: [], reason: body.error ?? body.reason ?? `Bridge error ${status}` };
  }
  return { ...body, steps: body.steps ?? [] };
}

export async function postCic(text: string): Promise<boolean> {
  if (MOCK) return mock.postCic(text);
  const { status } = await json<{ ok: boolean }>("/cic", post({ text }));
  return status < 400;
}

/** Returns the transcript, or null if the bridge could not transcribe (caller falls back to Web Speech). */
export async function transcribe(audio: Blob, selectedHex: string | null): Promise<string | null> {
  if (MOCK) return null;
  try {
    const q = selectedHex ? `?selected=${encodeURIComponent(selectedHex)}` : "";
    const res = await fetch(`${BRIDGE_URL}/transcribe${q}`, {
      method: "POST",
      headers: { "Content-Type": audio.type || "audio/webm" },
      body: audio,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { transcript?: string; error?: string };
    const t = body.transcript?.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

/** Fetches TTS audio from the bridge (Deepgram Aura-2). Null on failure. */
export async function speak(text: string, voice?: string): Promise<Blob | null> {
  if (MOCK) return null;
  try {
    const res = await fetch(`${BRIDGE_URL}/speak`, post(voice ? { text, voice } : { text }));
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

export async function getGrant(actor: ActorName, id: string): Promise<Grant> {
  if (MOCK) return mock.getGrant(actor, id);
  const { status, body } = await json<Grant & { error?: string }>(
    `/grant?actor=${encodeURIComponent(actor)}&id=${encodeURIComponent(id)}`,
  );
  if (status >= 400 || !body.websocketUrl) throw new Error(body.error ?? `grant ${status}`);
  return body;
}

export function openSocket(url: string): SocketLike {
  if (url.startsWith("mock://")) return mock.openSocket(url);
  return new WebSocket(url);
}
