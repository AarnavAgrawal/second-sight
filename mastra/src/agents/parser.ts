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
- Never invent a callsign that is not listed.`;

export const clearanceParser = new Agent({
  id: "clearance-parser",
  name: "Clearance parser",
  instructions: INSTRUCTIONS,
  model: FAST_MODEL,
});

export async function parseClearance(text: string, candidates: { callsign: string; spoken: string }[]): Promise<ParsedClearance> {
  const list = candidates.map((c) => `${c.callsign} = "${c.spoken}"`).join("\n");
  const prompt = `Aircraft in radar contact (ICAO = spoken):\n${list}\n\nCIC transmission: "${text}"`;
  const res = await clearanceParser.generate(prompt, {
    structuredOutput: { schema: ParsedClearanceSchema },
    maxSteps: 1,
  });
  return res.object as ParsedClearance;
}
