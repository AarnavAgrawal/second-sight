// RADAR and CIC identities on Agent Relay, plus the feed mirror (every Relay message -> Airspace.appendFeed).
// If Relay is unavailable the bridge keeps working and writes its own events straight to the feed.
import { airspace } from "../../shared/adapters/actors.ts";
import type { Channel, Relay, RelayMessage } from "../../shared/adapters/relay.ts";

let radar: Relay | null = null;
let cic: Relay | null = null;
let feedChain: Promise<unknown> = Promise.resolve();

function mirror(m: RelayMessage) {
  // Keep feed order: append sequentially.
  feedChain = feedChain
    .then(() => airspace().appendFeed({ ts: m.ts || Date.now(), from: m.from, to: m.to, text: m.text }))
    .catch((e) => console.error("[feed]", (e as Error).message));
}

export async function initRelay(): Promise<boolean> {
  try {
    const mod = await import("../../shared/adapters/relay.ts");
    radar = await mod.Relay.connect("RADAR", { type: "system", persona: "Radar data processor. Posts machine events." });
    cic = await mod.Relay.connect("CIC", { type: "human", persona: "Controller-in-Charge (human)." });
    radar.watchAll(mirror);
    console.log("[relay] connected as RADAR and CIC; mirroring feed");
    return true;
  } catch (e) {
    console.error("[relay] unavailable, events go straight to the feed:", (e as Error).message);
    radar = cic = null;
    return false;
  }
}

export const relayUp = () => !!radar;
export const cicRelay = () => cic;

async function fallbackFeed(from: string, to: string, text: string) {
  await airspace().appendFeed({ ts: Date.now(), from, to, text });
}

export async function postRadar(text: string, data: Record<string, unknown>): Promise<void> {
  console.log(`[radar] ${text}`);
  try {
    if (radar) await radar.post("radar", text, data);
    else await fallbackFeed("RADAR", "#radar", text);
  } catch (e) {
    console.error("[radar] post failed:", (e as Error).message);
    await fallbackFeed("RADAR", "#radar", text).catch(() => {});
  }
}

export async function postAs(who: "CIC" | "RADAR", channel: Channel, text: string, data?: Record<string, unknown>): Promise<void> {
  const r = who === "CIC" ? cic : radar;
  try {
    if (r) await r.post(channel, text, data);
    else await fallbackFeed(who, `#${channel}`, text);
  } catch (e) {
    console.error(`[relay] ${who} post failed:`, (e as Error).message);
    await fallbackFeed(who, `#${channel}`, text).catch(() => {});
  }
}
