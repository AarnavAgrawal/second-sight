// Adapter over the generated Terse client (regenerate with:
//   terse actor generate --out-dir shared/adapters/generated   while `terse actor dev` runs).
// Reads TERSE_ACTOR_URL / TERSE_API_KEY from env; defaults to the local dev server.
// If the Terse API shape changes, only this file and generated/ change.
import { actors } from "./generated/index.js";

export const AIRSPACE_ID = "main";

export const airspace = () => actors.Airspace.get(AIRSPACE_ID);
export const aircraft = (hex: string) => actors.Aircraft.get(hex.toLowerCase());
export const evalLog = (icao: string) => actors.EvalLog.get(icao.toUpperCase());

export type ActorName = "Airspace" | "Aircraft";

/** Mint a short-lived websocket grant for the browser. */
export async function grant(actor: ActorName, id: string): Promise<{ websocketUrl: string; connectByMs: number }> {
  const auth = { actorId: actor === "Aircraft" ? id.toLowerCase() : id, metadata: {} } as never;
  const g = actor === "Airspace" ? await actors.Airspace.prepareWebsocket(auth) : await actors.Aircraft.prepareWebsocket(auth);
  const { websocketUrl, connectByMs } = g as unknown as { websocketUrl: string; connectByMs: number };
  return { websocketUrl, connectByMs };
}
