// Phase 2+ routes: /clearance (Mastra clearance workflow), /transcribe and /speak (Deepgram). Filled in per phase.
const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function extraRoutes(req: Request, url: URL): Promise<Response | null> {
  if (req.method === "POST" && (url.pathname === "/clearance" || url.pathname === "/transcribe" || url.pathname === "/speak")) {
    return j({ error: `${url.pathname} is not available yet.` }, 503);
  }
  return null;
}
