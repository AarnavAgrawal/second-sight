// Phase 2+ routes: /clearance (Mastra clearance workflow), /transcribe and /speak (Deepgram).
import { airspace } from "../../shared/adapters/actors.ts";
import { runClearance } from "../../mastra/src/workflows/clearance.ts";
import { buildKeyterms, speak, transcribe, voiceConfigured } from "./voice.ts";

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function extraRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method === "POST" && url.pathname === "/clearance") {
    const body = (await req.json().catch(() => ({}))) as { text?: string; override?: boolean; selectedHex?: string | null };
    const text = (body.text || "").trim();
    if (!text) return j({ issued: false, transcript: "", reason: "Say again. Empty transmission.", sayAgain: true, steps: [] }, 400);
    const t0 = Date.now();
    const result = await runClearance({ text, override: !!body.override, selectedHex: body.selectedHex ?? null });
    console.log(`[clearance] "${text}" -> ${result.issued ? "ISSUED" : "NOT ISSUED"} (${Date.now() - t0} ms) ${result.reason ?? result.phraseology ?? ""}`);
    return j(result);
  }

  if (req.method === "POST" && url.pathname === "/transcribe") {
    if (!voiceConfigured()) return j({ error: "Deepgram not configured." }, 503);
    try {
      const audio = await req.arrayBuffer();
      if (audio.byteLength < 500) return j({ transcript: "" });
      const s = await airspace().snapshot();
      const keyterms = buildKeyterms({ traffic: s.traffic, airport: s.airport, selectedHex: url.searchParams.get("selected") });
      const r = await transcribe(audio, req.headers.get("content-type") || "audio/webm", keyterms);
      console.log(`[transcribe] "${r.transcript}" (${r.ms} ms, ${keyterms.length} keyterms)`);
      return j({ transcript: r.transcript, confidence: r.confidence });
    } catch (e) {
      console.error("[transcribe]", (e as Error).message);
      return j({ error: (e as Error).message }, 502);
    }
  }

  if (req.method === "POST" && url.pathname === "/speak") {
    if (!voiceConfigured()) return j({ error: "Deepgram not configured." }, 503);
    const body = (await req.json().catch(() => ({}))) as { text?: string; voice?: string };
    if (!body.text?.trim()) return j({ error: "Empty text." }, 400);
    try {
      const r = await speak(body.text, body.voice);
      return new Response(r.audio, { headers: { "Content-Type": r.contentType, "Cache-Control": "no-store", "X-Cache": r.cached ? "hit" : "miss" } });
    } catch (e) {
      console.error("[speak]", (e as Error).message);
      return j({ error: (e as Error).message }, 502);
    }
  }
  return null;
}
