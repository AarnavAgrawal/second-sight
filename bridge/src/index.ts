// Second Sight bridge: HTTP API for the UI, ADS-B poller, conflict alert loop, RADAR identity on Relay.
import { airspace, grant, type ActorName } from "../../shared/adapters/actors.ts";
import { resolveAirport } from "./airports.ts";
import { config, type DataSource } from "./config.ts";
import { poller } from "./poller.ts";
import { configureClearanceWorkflow } from "../../mastra/src/workflows/clearance.ts";
import { cicRelay, initRelay, postAs, postRadar, relayUp } from "./radar.ts";
import { extraRoutes } from "./routes.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
export const withCors = (r: Response) => {
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
};

async function startSession(code: string): Promise<Response> {
  const r = await resolveAirport(code);
  if ("error" in r) return json(r, 404);
  const airport = r.airport;
  const { session } = await airspace().configure(airport);
  const err = await poller.start(airport, session);
  await postRadar(`SESSION ${airport.icao} (${airport.name}) started, radius ${airport.radiusNm} NM`, {
    type: "SESSION",
    session,
    airport,
    dataSource: config.dataSource,
  });
  if (err) return json({ airport, error: err }, 409);
  return json({ airport });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && path === "/health") return json({ ok: true, ...poller.status(), relay: relayUp() });

  if (req.method === "GET" && path === "/config") {
    return json({ dataSource: config.dataSource, radiusNm: config.radiusNm, relayObserverUrl: config.relayObserverUrl, relay: relayUp() });
  }

  if (req.method === "GET" && path.startsWith("/airports/")) {
    const code = decodeURIComponent(path.slice("/airports/".length));
    const r = await resolveAirport(code);
    // CLAUDE.md 11: the matching Airport itself, or { error, suggestions }.
    return "error" in r ? json(r, 404) : json(r.airport);
  }

  if (req.method === "POST" && path === "/session") {
    const body = (await req.json().catch(() => ({}))) as { code?: string };
    if (!body.code) return json({ error: "Missing airport code." }, 400);
    return startSession(body.code);
  }

  // Switch live <-> replay at runtime (demo step 6). Restarts the poller for the current airport.
  if (req.method === "POST" && path === "/source") {
    const body = (await req.json().catch(() => ({}))) as { dataSource?: DataSource };
    if (body.dataSource !== "live" && body.dataSource !== "replay") return json({ error: "dataSource must be live or replay." }, 400);
    config.dataSource = body.dataSource;
    const { airport } = await airspace().getAirport();
    if (!airport) return json({ dataSource: config.dataSource });
    return startSession(airport.icao);
  }

  if (req.method === "GET" && path === "/grant") {
    const actor = url.searchParams.get("actor") as ActorName | null;
    const id = url.searchParams.get("id") || (actor === "Airspace" ? "main" : "");
    if ((actor !== "Airspace" && actor !== "Aircraft") || !id) return json({ error: "actor must be Airspace or Aircraft, with an id." }, 400);
    try {
      return json(await grant(actor, id));
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }
  }

  if (req.method === "POST" && path === "/cic") {
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    const text = (body.text || "").trim();
    if (!text) return json({ error: "Empty message." }, 400);
    await postAs("CIC", "cic", text, { type: "CIC", session: poller.session });
    return json({ ok: true });
  }

  const extra = await extraRoutes(req, url);
  if (extra) return withCors(extra);

  return json({ error: "Not found" }, 404);
}

Bun.serve({
  port: config.port,
  idleTimeout: 60,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e) {
      console.error("[http]", req.method, new URL(req.url).pathname, e);
      return json({ error: (e as Error).message }, 500);
    }
  },
});
console.log(`[bridge] http://localhost:${config.port}  data source: ${config.dataSource}`);

// Startup: connect Relay, then resume the active airport (or DEFAULT_AIRPORT).
await initRelay();
configureClearanceWorkflow({ relay: cicRelay() });
try {
  const { airport, session } = await airspace().getAirport();
  if (airport) {
    console.log(`[bridge] resuming ${airport.icao} (session ${session})`);
    const err = await poller.start(airport, session);
    if (err) console.error("[bridge]", err);
  } else if (config.defaultAirport) {
    console.log(`[bridge] configuring DEFAULT_AIRPORT ${config.defaultAirport}`);
    await startSession(config.defaultAirport);
  } else {
    console.log("[bridge] no airport yet; waiting for the UI to pick one");
  }
} catch (e) {
  console.error("[bridge] cannot reach the Terse actors. Is `terse actor dev` running (scripts/actor-dev.sh)?", (e as Error).message);
}
