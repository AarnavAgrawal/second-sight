// Detail card for the selected aircraft. Subscribes to its Aircraft actor while selected.
import type { Position, Sector, TrafficEntry } from "@shared/types.ts";
import type { AircraftActorState } from "../apiTypes.ts";
import { STATUS_LABEL, altText, clearanceShort, headingText, rateText } from "../format.ts";
import { useActor } from "../useActor.ts";

interface Props {
  entry: TrafficEntry;
  sector: Sector | null;
  declinationDeg: number;
  onClose: () => void;
  onClear: (hex: string) => void;
}

export function DetailCard({ entry, sector, declinationDeg, onClose, onClear }: Props) {
  const sub = useActor<AircraftActorState>("Aircraft", entry.hex);
  const st = sub.state;
  const clearance = st?.clearance ?? null;
  const status = st?.status ?? entry.status;
  const magTrack = (((entry.trackTrueDeg - declinationDeg) % 360) + 360) % 360;

  return (
    <div className={`detail st-${status}`}>
      <div className="detail-head">
        <div>
          <div className="detail-cs">{entry.callsign || entry.hex.toUpperCase()}</div>
          <div className="dim">
            {entry.typeCode ?? "----"} · {entry.hex.toUpperCase()} · {sector ? `${sector} sector` : "no track control"}
          </div>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="detail-grid">
        <div>
          <span className="k">ALT</span>
          {altText(entry.altFt)}
        </div>
        <div>
          <span className="k">V/S</span>
          {rateText(entry.vertRateFpm)}
        </div>
        <div>
          <span className="k">GS</span>
          {Math.round(entry.gsKt)} kt
        </div>
        <div>
          <span className="k">TRK</span>
          {headingText(magTrack)}°M
        </div>
      </div>
      {clearance ? (
        <>
          <div className="detail-clr">
            <span className="k">CLEARANCE</span> {clearanceShort(clearance)} <span className="dim">by {clearance.issuedBy}</span>
          </div>
          <div className="detail-phr">{clearance.phraseology}</div>
        </>
      ) : (
        <div className="detail-clr dim">{sub.state || sub.error ? "No active clearance" : "Loading…"}</div>
      )}
      <div className={`detail-status st-${status}`}>
        <b>{STATUS_LABEL[status]}</b>
        {st?.statusReason && <span> · {st.statusReason}</span>}
      </div>
      {st && st.track.length > 1 && <AltChart track={st.track} cleared={clearance?.kind === "altitude" ? clearance.value : null} />}
      <button className="btn small" onClick={() => onClear(entry.hex)}>
        Clearance for {entry.callsign}…
      </button>
    </div>
  );
}

function AltChart({ track, cleared }: { track: Position[]; cleared: number | null }) {
  const pts = track.filter((p) => p.altFt != null);
  if (pts.length < 2) return null;
  const W = 300;
  const H = 84;
  const pad = 6;
  const t0 = pts[0]!.ts;
  const t1 = pts[pts.length - 1]!.ts;
  const alts = pts.map((p) => p.altFt!);
  if (cleared != null) alts.push(cleared);
  let lo = Math.min(...alts);
  let hi = Math.max(...alts);
  if (hi - lo < 1000) {
    const mid = (hi + lo) / 2;
    lo = mid - 500;
    hi = mid + 500;
  }
  const x = (ts: number) => pad + ((ts - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const y = (a: number) => H - pad - ((a - lo) / (hi - lo)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.altFt!).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Altitude history">
        {cleared != null && (
          <>
            <line x1={pad} x2={W - pad} y1={y(cleared)} y2={y(cleared)} className="chart-clr" />
            <text x={W - pad} y={y(cleared) - 4} textAnchor="end" className="chart-lbl">
              CLR {altText(cleared)}
            </text>
          </>
        )}
        <path d={d} className="chart-line" />
        <circle cx={x(last.ts)} cy={y(last.altFt!)} r={3} className="chart-dot" />
      </svg>
      <div className="chart-axis dim">
        <span>{altText(lo)}</span>
        <span>altitude, last {Math.round((t1 - t0) / 1000)} s</span>
        <span>{altText(hi)}</span>
      </div>
    </div>
  );
}
