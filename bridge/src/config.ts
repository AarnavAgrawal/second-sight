// Bridge configuration from env (Bun loads the repo-root .env when run via `bun run bridge`).
export type DataSource = "live" | "replay";

export const config = {
  port: Number(process.env.BRIDGE_PORT || 8787),
  radiusNm: Number(process.env.RADIUS_NM || 35),
  defaultAirport: (process.env.DEFAULT_AIRPORT || "").trim().toUpperCase(),
  dataSource: ((process.env.DATA_SOURCE || "live").trim().toLowerCase() === "replay" ? "replay" : "live") as DataSource,
  pollMs: 5_000,
  /** Terminal-area rule: only aircraft below this altitude are handed off between sectors. */
  handoffCeilingFt: Number(process.env.HANDOFF_CEILING_FT || 18_000),
  /** Conflict alert ignores pairs where both aircraft are below this height above the field (low-level GA). */
  caFloorAglFt: Number(process.env.CA_FLOOR_AGL_FT || 2_500),
  adsbBase: process.env.ADSB_BASE_URL || "https://api.adsb.lol/v2",
  relayObserverUrl: process.env.RELAY_OBSERVER_URL || "https://agentrelay.com/observer",
};

export const repoRoot = new URL("../../", import.meta.url);
export const repoPath = (rel: string) => decodeURIComponent(new URL(rel, repoRoot).pathname).replace(/^\/([A-Za-z]:)/, "$1");
