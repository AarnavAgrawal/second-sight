// Starts the bridge and the three agents (NORTH, SOUTH, MONITOR) with prefixed logs; Ctrl+C stops all.
//   bun run backend            (the Terse actors must already be running: scripts/actor-dev.sh in WSL)
// Extra env (e.g. CLEARANCE_MODE=direct) is passed through.
// Use this Bun's own executable: "bun" may not be on PATH for spawned processes (Windows).
const BUN = process.execPath;
const procs = [
  { name: "BRIDGE ", cmd: [BUN, "bridge/src/index.ts"], delayMs: 0 },
  { name: "NORTH  ", cmd: [BUN, "agents/src/index.ts", "NORTH"], delayMs: 1500 },
  { name: "SOUTH  ", cmd: [BUN, "agents/src/index.ts", "SOUTH"], delayMs: 1500 },
  { name: "MONITOR", cmd: [BUN, "agents/src/index.ts", "MONITOR"], delayMs: 1500 },
];
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const children: ReturnType<typeof Bun.spawn>[] = [];

async function pipe(name: string, stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      console.log(`${name} | ${buf.slice(0, i)}`);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) console.log(`${name} | ${buf}`);
}

for (const p of procs) {
  if (p.delayMs) await Bun.sleep(p.delayMs);
  const child = Bun.spawn(p.cmd, { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env });
  children.push(child);
  void pipe(p.name, child.stdout as ReadableStream<Uint8Array>);
  void pipe(p.name, child.stderr as ReadableStream<Uint8Array>);
  void child.exited.then((code) => console.log(`${p.name} | exited (${code})`));
}

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(children.map((c) => c.exited));
