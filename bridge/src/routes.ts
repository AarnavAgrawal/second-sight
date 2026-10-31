// Phase 2+ routes: /clearance (Mastra clearance workflow), /transcribe and /speak (Deepgram). Filled in per phase.
import { runClearance } from "../../mastra/src/workflows/clearance.ts";
import { postAs } from "./radar.ts";

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function clearance(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { text?: string; override?: boolean };
  const text = (body.text ?? "").trim();
  if (!text) return j({ error: "Missing clearance text." }, 400);
  const override = body.override === true;
  const r = await runClearance(text, override);
  const { done: _done, currentAltFt: _alt, ...out } = r;
  if (r.issued && r.phraseology) {
    const p = r.probe;
    const warn = override && p && !p.ok ? ` CIC override. Probe warnings: ${p.reasons.join(" ")}` : "";
    await postAs("CIC", "cic", `${r.phraseology}${warn}`, { type: "CLEARANCE", callsign: r.parsed?.callsign, hex: r.hex, sector: r.sector, override, probe: p });
  }
  console.log(`[clearance] "${text}" -> ${r.issued ? "issued" : `not issued (${r.reason})`}`);
  return j({ ...out, ...(override ? { override } : {}) }, r.sayAgain ? 422 : 200);
}

export async function extraRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method === "POST" && url.pathname === "/clearance") return clearance(req);
  if (req.method === "POST" && (url.pathname === "/transcribe" || url.pathname === "/speak")) {
    return j({ error: `${url.pathname} is not available yet.` }, 503);
  }
  return null;
}
