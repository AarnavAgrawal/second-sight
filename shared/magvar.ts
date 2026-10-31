// Magnetic variation from the World Magnetic Model (offline, npm `geomagnetism`, bundles WMM2025
// valid 2024-11-13 to 2029-11-13). Compute once per airport on configure.
import geomagnetism from "geomagnetism";

/** East-positive magnetic declination in degrees. Magnetic = true - declination. */
export function declinationDeg(lat: number, lon: number, date: Date = new Date()): number {
  let model;
  try {
    model = geomagnetism.model(date);
  } catch {
    // Date outside every bundled model: fall back to the newest model, extrapolated.
    model = geomagnetism.model(date, { allowOutOfBoundsModel: true });
  }
  const decl = model.point([lat, lon]).decl;
  return Math.round(decl * 100) / 100;
}
