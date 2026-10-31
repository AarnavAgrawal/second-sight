// Move evaluation data between machines. The EvalLog actor's SQLite is local to each machine.
//   bun run listener:export [ICAO]   EvalLog -> data/eval/<ICAO>/heard.jsonl
//   bun run listener:import [ICAO]   data/eval/<ICAO>/heard.jsonl -> EvalLog (rows already stored are kept)
// The bridge also imports automatically on the first /eval request when EvalLog is empty.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { evalLog } from "../../shared/adapters/actors.ts";
import type { HeardTransmission } from "../../shared/types.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
export const seedPath = (icao: string) => `${ROOT}data/eval/${icao.toUpperCase()}/heard.jsonl`;

export async function exportHeard(icao: string): Promise<number> {
  const rows = await evalLog(icao).heard(0, Number.MAX_SAFE_INTEGER);
  mkdirSync(`${ROOT}data/eval/${icao.toUpperCase()}`, { recursive: true });
  writeFileSync(seedPath(icao), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows.length;
}

export async function importHeard(icao: string): Promise<number> {
  const file = seedPath(icao);
  if (!existsSync(file)) return 0;
  const log = evalLog(icao);
  const have = new Set((await log.heard(0, Number.MAX_SAFE_INTEGER)).map((h) => h.id));
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HeardTransmission).filter((r) => !have.has(r.id));
  for (let i = 0; i < rows.length; i += 100) await log.addHeard(rows.slice(i, i + 100));
  return rows.length;
}

if (import.meta.main) {
  const [cmd, icaoArg] = process.argv.slice(2);
  const icao = (icaoArg ?? "KSFO").toUpperCase();
  if (cmd === "export") console.log(`exported ${await exportHeard(icao)} heard transmissions -> data/eval/${icao}/heard.jsonl`);
  else if (cmd === "import") console.log(`imported ${await importHeard(icao)} heard transmissions into EvalLog ${icao}`);
  else console.log("usage: bun listener/src/seed.ts export|import [ICAO]");
}
