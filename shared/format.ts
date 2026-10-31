// Display formatting helpers (no locale APIs, so output is identical everywhere).

/** 7800 -> "7,800". Rounds to an integer first. */
export function withCommas(n: number): string {
  const sign = n < 0 ? "-" : "";
  const s = String(Math.round(Math.abs(n)));
  return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Round to the nearest multiple of `step`. */
export function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/** Three-digit heading text: 45 -> "045", 0 -> "360". */
export function headingText(deg: number): string {
  let h = Math.round(((deg % 360) + 360) % 360);
  if (h === 0) h = 360;
  return String(h).padStart(3, "0");
}

/**
 * STARS-style data block line 2: altitude in hundreds of feet (3 digits), vertical trend arrow,
 * ground speed in tens of knots. Example: dataBlock(7800, 1800, 280) -> "078↑ 28".
 */
export function dataBlock(altFt: number | null, vertRateFpm: number, gsKt: number): string {
  const alt = altFt == null ? "---" : String(Math.max(0, Math.round(altFt / 100))).padStart(3, "0");
  const arrow = vertRateFpm > 500 ? "↑" : vertRateFpm < -500 ? "↓" : " ";
  const gs = String(Math.max(0, Math.round(gsKt / 10))).padStart(2, "0");
  return `${alt}${arrow} ${gs}`;
}
