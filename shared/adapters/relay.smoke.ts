/**
 * Live smoke test for the Relay adapter. Run from the repo root:
 *   bun shared/adapters/relay.smoke.ts            full test (SMOKE_A / SMOKE_B)
 *   bun shared/adapters/relay.smoke.ts connect X  connect identity X and exit (used for the race test)
 *   bun shared/adapters/relay.smoke.ts race       connect RADAR, CIC, NORTH, SOUTH, MONITOR in 5 parallel processes
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Relay, workspaceInfo, type RelayMessage } from "./relay";

const ROLES: Record<string, "agent" | "human" | "system"> = {
  RADAR: "system",
  CIC: "human",
  NORTH: "agent",
  SOUTH: "agent",
  MONITOR: "agent",
};
const IDENTITY_PATH = fileURLToPath(new URL("../../.relay-identities.json", import.meta.url));

const [mode, arg] = process.argv.slice(2);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

if (mode === "connect") {
  const t0 = Date.now();
  const r = await Relay.connect(arg!, { type: ROLES[arg!] ?? "agent" });
  console.log(`connected ${r.name} in ${Date.now() - t0} ms`);
  process.exit(0);
}

if (mode === "race") {
  const t0 = Date.now();
  const procs = Object.keys(ROLES).map((n) =>
    Bun.spawn(["bun", fileURLToPath(import.meta.url), "connect", n], { stdout: "inherit", stderr: "inherit" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  const f = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
  assert(codes.every((c) => c === 0), `all 5 processes connected (${Date.now() - t0} ms)`);
  assert(Object.keys(ROLES).every((n) => f.agents[n]?.token), "all 5 tokens persisted in one workspace");
  console.log("workspace", workspaceInfo());
  process.exit(0);
}

// ------------------------------------------------------------ full smoke test
const t0 = Date.now();
const a = await Relay.connect("SMOKE_A", { type: "system", persona: "smoke test sender" });
const b = await Relay.connect("SMOKE_B", { type: "agent", persona: "smoke test receiver" });
console.log(`connected both in ${Date.now() - t0} ms`, workspaceInfo());

const gotB: RelayMessage[] = [];
const gotAll: RelayMessage[] = [];
const gotA: RelayMessage[] = [];
const recvAt = new Map<string, number>();
b.onMessage((m) => {
  gotB.push(m);
  recvAt.set(`B:${m.id}`, Date.now());
});
a.onMessage((m) => {
  gotA.push(m);
});
b.watchAll((m) => {
  gotAll.push(m);
  recvAt.set(`ALL:${m.id}`, Date.now());
});
await Bun.sleep(1500); // let the cursor initialise ("from now")

const nonce = crypto.randomUUID().slice(0, 8);
const sendStart = Date.now();
const posted = await a.post("radar", `CA SMOKE1/SMOKE2 predicted 1.8 NM / 400 FT in 70 s (NORTH/SOUTH) ${nonce}`, {
  type: "CA",
  a: "SMOKE1",
  b: "SMOKE2",
  predictedLatNm: 1.8,
  nonce,
});
const postAck = Date.now() - sendStart;
const dmStart = Date.now();
const dmed = await a.dm("SMOKE_B", `Handoff, United one twenty-three ${nonce}`, { type: "HANDOFF", hex: "abc123", nonce });
const dmAck = Date.now() - dmStart;
assert(posted.to === "#radar" && posted.data?.nonce === nonce && posted.from === "SMOKE_A", "post() returns mapped message with data");
assert(dmed.to === "SMOKE_B" && dmed.kind === "dm" && dmed.data?.nonce === nonce, "dm() returns mapped message with data");

// waitFor: B replies to A, A waits for it.
const waitStart = Date.now();
const replyWait = a.waitFor((m) => m.kind === "dm" && m.from === "SMOKE_B" && m.data?.nonce === nonce, 10_000);
const replyStart = Date.now();
await b.dm("SMOKE_A", `United one twenty-three, radar contact ${nonce}`, { type: "HANDOFF_ACCEPT", nonce });
const reply = await replyWait;
assert(reply && reply.text.includes("radar contact"), `waitFor() got the DM reply (${Date.now() - replyStart} ms after send, ${Date.now() - waitStart} ms total)`);
assert((await a.waitFor(() => false, 300)) === null, "waitFor() times out with null");

const deadline = Date.now() + 10_000;
while (Date.now() < deadline && !(gotB.length >= 2 && gotAll.length >= 3)) await Bun.sleep(100);

const bPost = gotB.find((m) => m.id === posted.id);
const bDm = gotB.find((m) => m.id === dmed.id);
assert(bPost && bPost.from === "SMOKE_A" && bPost.to === "#radar" && bPost.kind === "channel", "onMessage: B got channel post with from/to");
assert(bPost!.data?.predictedLatNm === 1.8 && bPost!.data?.nonce === nonce && !("injection_mode" in bPost!.data!), "onMessage: channel data intact");
assert(bDm && bDm.from === "SMOKE_A" && bDm.to === "SMOKE_B" && bDm.kind === "dm", "onMessage: B got DM with from/to");
assert(bDm!.data?.hex === "abc123" && bDm!.data?.nonce === nonce && !("injection_mode" in bDm!.data!), "onMessage: DM data intact");
assert(!gotB.some((m) => m.from === "SMOKE_B"), "onMessage excludes own sends");
assert(!gotA.some((m) => m.id === posted.id || m.id === dmed.id), "onMessage: sender does not receive its own post/DM");
assert(gotA.some((m) => m.kind === "dm" && m.to === "SMOKE_A"), "onMessage: A got B's DM");
assert(new Set(gotB.map((m) => m.id)).size === gotB.length, "no duplicate deliveries");
const allIds = new Set(gotAll.map((m) => m.id));
assert(allIds.has(posted.id) && allIds.has(dmed.id) && allIds.has(reply!.id), "watchAll sees channel + both DMs (incl. own sends)");
assert(gotAll.find((m) => m.id === reply!.id)?.to === "SMOKE_A", "watchAll: DM between others has correct recipient");

console.log("\nlatency (send start -> handler):");
console.log(`  post:  ack ${postAck} ms, onMessage ${recvAt.get(`B:${posted.id}`)! - sendStart} ms, watchAll ${recvAt.get(`ALL:${posted.id}`)! - sendStart} ms`);
console.log(`  dm:    ack ${dmAck} ms, onMessage ${recvAt.get(`B:${dmed.id}`)! - dmStart} ms, watchAll ${recvAt.get(`ALL:${dmed.id}`)! - dmStart} ms`);
console.log("\nsample received DM:", JSON.stringify(bDm));

// Lost-token recovery: drop SMOKE_B's token from the file and reconnect (takeover path).
a.close();
b.close();
const f = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
const oldToken = f.agents.SMOKE_B.token;
delete f.agents.SMOKE_B;
writeFileSync(IDENTITY_PATH, JSON.stringify(f, null, 2));
const b2 = await Relay.connect("SMOKE_B", { type: "agent" });
const f2 = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
assert(f2.agents.SMOKE_B?.token && f2.agents.SMOKE_B.token !== oldToken, "lost token recovered via takeover and persisted");
const again = await b2.post("radar", `SMOKE recovered ${nonce}`, { nonce });
assert(again.from === "SMOKE_B", "recovered identity can post");
b2.close();

console.log("\nALL GREEN");
process.exit(0);
