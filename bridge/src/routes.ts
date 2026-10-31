// Phase 2+ routes: /clearance (Mastra clearance workflow), /transcribe and /speak (Deepgram).
import { airspace } from "../../shared/adapters/actors.ts";
import { runClearance } from "../../mastra/src/workflows/clearance.ts";
import { buildKeyterms, speak, transcribe, voiceConfigured } from "./voice.ts";
import { evalRoute } from "./eval.ts";

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function extraRoutes(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith("/eval/")) return evalRoute(req, url);
  if (req.method === "POST" && url.pathname === "/clearance") {
    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      override?: boolean;
      confirmed?: boolean;
      selectedHex?: string | null;
      clearance?: { callsign: string; kind: "altitude" | "heading"; value: number; turn?: "left" | "right" };
    };
    const text = (body.text || "").trim();
    if (!text && !body.clearance) return j({ issued: false, transcript: "", reason: "Say again. Empty transmission.", sayAgain: true, steps: [] }, 400);
    const input = {
      text: text || `${body.clearance!.callsign} ${body.clearance!.kind} ${body.clearance!.value}`,
      override: !!body.override,
      confirmed: !!body.confirmed,
      selectedHex: body.selectedHex ?? null,
      ...(body.clearance ? { clearance: body.clearance } : {}),
    };
    const t0 = Date.now();
    const logResult = (r: { issued: boolean; reason?: string; phraseology?: string }) =>
      console.log(`[clearance] "${input.text}"${input.override ? " (OVERRIDE)" : ""} -> ${r.issued ? "ISSUED" : "NOT ISSUED"} (${Date.now() - t0} ms) ${r.reason ?? r.phraseology ?? ""}`);

    // Streaming mode (CLAUDE.md 11: "stream step progress to the UI"): Server-Sent Events.
    //   event: step   data: { id, status, detail, ms }   (one per workflow step as it completes)
    //   event: result data: <same JSON as the non-streaming response>
    const wantsStream = (req.headers.get("accept") || "").includes("text/event-stream") || url.searchParams.get("stream") === "1";
    if (wantsStream) {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          try {
            const result = await runClearance(input, (e) => send("step", e));
            logResult(result);
            send("result", result);
          } catch (e) {
            send("result", { issued: false, transcript: input.text, reason: (e as Error).message, steps: [] });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }

    const result = await runClearance(input);
    logResult(result);
    // 422 when the transmission couldn't be parsed or the callsign isn't in radar contact ("Say again").
    return j(result, result.sayAgain ? 422 : 200);
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
