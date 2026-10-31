// Agreements between sectors (ai-updates.md 3c) and the recent conflicting clearance check (3d).
import type {
  Agreement,
  AgreementConstraint,
  Candidate,
  Clearance,
  ClearanceRequest,
  RecentConflict,
  Sector,
} from "./types.ts";
import { angleDiff } from "./geo.ts";
import { formatAltitude } from "./conformance.ts";
import { headingText, withCommas } from "./format.ts";

export const HEADING_AGREEMENT_TOLERANCE_DEG = 5;
export const RECENT_CLEARANCE_SEC = 60;
export const RECENT_ALT_CHANGE_FT = 3000;
export const RECENT_HEADING_CHANGE_DEG = 60;

/** Agreements in state "active" that have not reached `expiresAt`. */
export function activeAgreements(agreements: Agreement[], now: number): Agreement[] {
  return agreements.filter((a) => a.state === "active" && now < a.expiresAt);
}

function breaks(c: AgreementConstraint, req: ClearanceRequest): boolean {
  if (c.kind !== req.kind) return false;
  if (c.kind === "altitude") {
    if (c.op === "maintain") return req.value !== c.value;
    if (c.op === "at_or_below") return req.value > c.value;
    return req.value < c.value;
  }
  if (c.op === "maintain") return Math.abs(angleDiff(c.value, req.value)) > HEADING_AGREEMENT_TOLERANCE_DEG;
  return false;
}

/** Active agreements for this aircraft (by hex) that the clearance would break. */
export function checkAgreements(hex: string, req: ClearanceRequest, agreements: Agreement[], now: number): Agreement[] {
  return activeAgreements(agreements, now).filter((a) => a.hex === hex && breaks(a.constraint, req));
}

function constraintText(c: AgreementConstraint): string {
  const op = c.op === "maintain" ? "maintain" : c.op === "at_or_below" ? "at or below" : "at or above";
  return c.kind === "altitude" ? `${op} ${formatAltitude(c.value)}` : `${op} heading ${headingText(c.value)}`;
}

/** Build an agreement (without id/timestamps/state) from a chosen candidate: maintain its altitude or heading. */
export function agreementFromCandidate(input: {
  hex: string;
  callsign: string;
  candidate: Pick<Candidate, "kind" | "value" | "turn">;
  between: Sector[];
  source: Agreement["source"];
  note?: string;
}): {
  hex: string;
  callsign: string;
  constraint: AgreementConstraint;
  between: Sector[];
  source: Agreement["source"];
  text: string;
} {
  const constraint: AgreementConstraint = { kind: input.candidate.kind, op: "maintain", value: input.candidate.value };
  const note = input.note?.trim();
  const text = `${input.callsign} ${constraintText(constraint)}${note ? ` ${note}` : ""} (${input.source})`;
  return {
    hex: input.hex,
    callsign: input.callsign,
    constraint,
    between: [...input.between],
    source: input.source,
    text,
  };
}

/**
 * The previous clearance, if it was issued less than 60 s ago and the new request reverses it
 * (climb vs descend, left vs right) or changes it by more than 3,000 ft or 60 degrees. Otherwise null.
 */
export function recentConflictingClearance(
  prev: Clearance | null,
  requested: ClearanceRequest,
  currentAltFt: number | null,
  now: number,
): RecentConflict | null {
  if (!prev || prev.kind !== requested.kind) return null;
  const ageMs = now - prev.issuedAt;
  if (ageMs >= RECENT_CLEARANCE_SEC * 1000) return null;
  const secondsAgo = Math.max(0, Math.round(ageMs / 1000));
  const ago = secondsAgo < 10 ? "moments ago" : `${secondsAgo} s ago`;

  if (requested.kind === "altitude") {
    if (currentAltFt != null) {
      const prevDir = Math.sign(prev.value - currentAltFt);
      const newDir = Math.sign(requested.value - currentAltFt);
      if (prevDir !== 0 && newDir !== 0 && prevDir !== newDir) {
        const what = prevDir > 0 ? "climb" : "descent";
        return { clearance: prev, secondsAgo, why: `reverses the ${what} to ${formatAltitude(prev.value)} issued ${ago}` };
      }
    }
    const change = Math.abs(requested.value - prev.value);
    if (change > RECENT_ALT_CHANGE_FT) {
      return {
        clearance: prev,
        secondsAgo,
        why: `${withCommas(change)} ft from the ${formatAltitude(prev.value)} cleared ${ago}`,
      };
    }
    return null;
  }

  if (prev.turn && requested.turn && prev.turn !== requested.turn) {
    return {
      clearance: prev,
      secondsAgo,
      why: `reverses the ${prev.turn} turn to heading ${headingText(prev.value)} issued ${ago}`,
    };
  }
  const change = Math.abs(angleDiff(prev.value, requested.value));
  if (change > RECENT_HEADING_CHANGE_DEG) {
    return {
      clearance: prev,
      secondsAgo,
      why: `${Math.round(change)} degrees from heading ${headingText(prev.value)} cleared ${ago}`,
    };
  }
  return null;
}
