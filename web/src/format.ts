// Small display helpers for the scope and panels (web-only; mirrors shared/format.ts).
import type { ClearanceRequest, Status } from "@shared/types.ts";

/** Vertical rate (fpm) above which a target shows a trend arrow. */
export const TREND_FPM = 300;

/** Data block line 2: altitude in hundreds of feet (3 digits) + trend arrow + ground speed in tens of knots. */
export function dataBlock(altFt: number | null, vertRateFpm: number, gsKt: number): string {
  const alt = altFt == null ? "---" : String(Math.max(0, Math.round(altFt / 100))).padStart(3, "0");
  const arrow = vertRateFpm >= TREND_FPM ? "↑" : vertRateFpm <= -TREND_FPM ? "↓" : " ";
  const gs = String(Math.max(0, Math.round(gsKt / 10))).padStart(2, "0");
  return `${alt}${arrow} ${gs}`;
}

/** "7,800 ft" or "FL230". */
export function altText(altFt: number | null): string {
  if (altFt == null) return "---";
  if (altFt >= 18000) return `FL${String(Math.round(altFt / 100)).padStart(3, "0")}`;
  return `${Math.round(altFt).toLocaleString("en-US")} ft`;
}

export function rateText(fpm: number): string {
  const r = Math.round(fpm / 100) * 100;
  if (Math.abs(r) < 100) return "level";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toLocaleString("en-US")} fpm`;
}

export function headingText(deg: number): string {
  const h = Math.round(deg) % 360 || 360;
  return String(h).padStart(3, "0");
}

/** Compact written form of a clearance, e.g. "ALT 10,000" / "HDG 270 L". */
export function clearanceShort(c: ClearanceRequest): string {
  if (c.kind === "altitude") return `ALT ${altText(c.value)}`;
  return `HDG ${headingText(c.value)}${c.turn ? ` ${c.turn === "left" ? "L" : "R"}` : ""}`;
}

export const STATUS_LABEL: Record<Status, string> = {
  none: "NO CLNC",
  pending: "PENDING",
  conforming: "CONFORMING",
  non_conforming: "NON-CONFORMING",
  coasting: "COASTING",
};

export function zulu(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
