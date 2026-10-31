// Clearance parser: a Mastra agent on the fast model that turns CIC speech/text into a structured clearance.
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { FAST_MODEL } from "../models.ts";

export const ParsedClearanceSchema = z.object({
  callsign: z.string().nullable().describe("ICAO callsign exactly as listed (e.g. UAL123), or null if no listed aircraft matches"),
  kind: z.enum(["altitude", "heading"]).nullable(),
  value: z
    .number()
    .int()
    .nullable()
    .describe("Altitude in feet (flight level two three zero = 23000, one zero thousand = 10000) or magnetic heading 1-360"),
  turn: z.enum(["left", "right"]).nullable().describe("Only when the controller said turn left/right"),
  confidence: z
    .enum(["high", "low"])
    .describe("low if the callsign is only a partial match or matches more than one listed aircraft, or the altitude/heading is missing or garbled"),
  ambiguousWith: z
    .array(z.string())
    .nullable()
    .describe('When the callsign could be more than one listed aircraft: ALL the matching ICAO callsigns (e.g. ["SWA2140", "SWA2155"]), else null'),
  problem: z.string().nullable().describe("Short reason if the clearance can't be parsed, else null"),
});
export type ParsedClearance = z.infer<typeof ParsedClearanceSchema>;

const INSTRUCTIONS = `You parse air traffic control clearances spoken or typed by the Controller-in-Charge (CIC).
Return exactly one clearance: an altitude clearance or a heading clearance for one aircraft.

Rules:
- The callsign must be one of the listed aircraft. Match spoken forms ("United one twenty-three", "United one two three", "November three four five alpha bravo") to the ICAO callsign (UAL123, N345AB). Tolerate speech-to-text errors (e.g. "you knighted" = United, "south west" = Southwest, digits written as numerals).
- Altitudes: "climb and maintain one zero thousand" = 10000; "eight thousand" = 8000; "six thousand five hundred" = 6500; "one two thousand" = 12000; "flight level two three zero" = 23000; "FL240" = 24000. "Climb/descend/maintain" are all kind "altitude".
- Headings: "turn left heading two seven zero" = heading 270, turn left; "fly heading zero niner zero" = 90, turn null; "heading three six zero" = 360.
- If there is no clear callsign from the list, or no clear altitude or heading, set the missing fields to null and explain in "problem".
- Never invent a callsign that is not listed.
- Ambiguity: if the spoken callsign is a partial match that fits more than one listed aircraft (e.g. "Southwest twenty-one" when SWA2140 and SWA2155 are both listed), set confidence "low" and list ALL matching callsigns in ambiguousWith. Don't guess between them.
- confidence "low" also when the altitude or heading is missing or garbled. Otherwise "high".
- The recent clearances are context only (the CIC may be correcting one); never copy values from them.`;

export const clearanceParser = new Agent({
  id: "clearance-parser",
  name: "Clearance parser",
  instructions: INSTRUCTIONS,
  model: FAST_MODEL,
});

export async function parseClearance(
  text: string,
  candidates: { callsign: string; spoken: string }[],
  recentClearances: string[] = [],
): Promise<ParsedClearance> {
  const list = candidates.map((c) => `${c.callsign} = "${c.spoken}"`).join("\n");
  const recent = recentClearances.length ? `\n\nLast clearances issued (context only):\n${recentClearances.map((r) => `- ${r}`).join("\n")}` : "";
  const prompt = `Aircraft in radar contact (ICAO = spoken):\n${list}${recent}\n\nCIC transmission: "${text}"`;
  const res = await clearanceParser.generate(prompt, {
    structuredOutput: { schema: ParsedClearanceSchema },
    maxSteps: 1,
  });
  return res.object as ParsedClearance;
}
