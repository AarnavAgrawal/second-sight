// Transmission parser: a Mastra agent on the fast model that reads one transcribed transmission from a real
// ATC frequency and extracts who spoke, which aircraft it was, and any altitude/heading clearance.
// Evaluation data only: it never issues anything.
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { FAST_MODEL } from "../models.ts";

export const ParsedTransmissionSchema = z.object({
  speaker: z.enum(["controller", "pilot", "unknown"]),
  callsign: z.string().nullable().describe("ICAO callsign exactly as listed, or null if no listed aircraft matches"),
  clearances: z
    .array(
      z.object({
        kind: z.enum(["altitude", "heading"]),
        value: z.number().int().describe("Altitude in feet or magnetic heading 1-360"),
        turn: z.enum(["left", "right"]).nullable(),
      }),
    )
    .describe("Altitude/heading assignments issued (controller) or read back (pilot). Empty if none."),
  note: z.string().nullable().describe("Other content in a few words: frequency change, approach clearance, traffic call, speed. Null if nothing."),
});
export type ParsedTransmission = z.infer<typeof ParsedTransmissionSchema>;

const INSTRUCTIONS = `You read single radio transmissions transcribed (imperfectly) from a real US approach control frequency.
Return who spoke, which aircraft, and any altitude or heading assignment.

Speaker:
- controller: addresses an aircraft and assigns something ("Southwest thirty six eighty six, turn left heading three one zero, maintain one zero thousand"), gives traffic, or hands off ("contact San Francisco Tower one two zero point five").
- pilot: checks in ("NorCal Approach, United two seventy one, descending through one two thousand") or reads back, usually ending with the callsign ("left three one zero, maintain one zero thousand, Southwest thirty six eighty six").
- unknown: too garbled to tell.

Callsign: match the spoken or numeric form to one listed ICAO callsign ("Southwest thirty six eighty six" or "Southwest 3686" = SWA3686, "American 271" = AAL271). Tolerate transcription errors in the airline name, but the flight number must fit. Never invent a callsign that is not listed; use null.

Clearances (both controller assignments and pilot readbacks):
- "climb/descend and maintain one zero thousand" or "maintain ten thousand" = altitude 10000; "six thousand" = 6000; "flight level two four zero" = 24000.
- "turn left heading three one zero" = heading 310, turn left; "fly heading zero niner zero" = heading 90, turn null.
- Skip a value you cannot read with confidence. Altitudes in a check-in ("descending through one two thousand") are reports, not assignments: do not list them.`;

export const transmissionParser = new Agent({
  id: "transmission-parser",
  name: "Transmission parser",
  instructions: INSTRUCTIONS,
  model: FAST_MODEL,
});

export async function parseTransmission(text: string, candidates: { callsign: string; spoken: string }[]): Promise<ParsedTransmission> {
  const list = candidates.map((c) => `${c.callsign} = "${c.spoken}"`).join("\n");
  const prompt = `Aircraft on radar at that moment (ICAO = spoken):\n${list}\n\nTransmission: "${text}"`;
  const res = await transmissionParser.generate(prompt, {
    structuredOutput: { schema: ParsedTransmissionSchema },
    maxSteps: 1,
  });
  return res.object as ParsedTransmission;
}
