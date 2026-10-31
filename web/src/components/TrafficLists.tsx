// Left panel lists: climbing/descending filter, active clearances, conflict alerts.
import type { ConflictAlert, Handoff, Sector, TrafficEntry } from "@shared/types.ts";
import { STATUS_LABEL, altText, rateText } from "../format.ts";

export const VS_FILTER_FPM = 500;

interface Props {
  traffic: TrafficEntry[];
  conflicts: ConflictAlert[];
  handoffs: Handoff[];
  trackControl: Record<string, Sector>;
  selectedHex: string | null;
  filterOn: boolean;
  setFilterOn: (b: boolean) => void;
  onPick: (hex: string) => void;
}

export function TrafficLists({ traffic, conflicts, handoffs, trackControl, selectedHex, filterOn, setFilterOn, onPick }: Props) {
  const vs = traffic
    .filter((t) => Math.abs(t.vertRateFpm) > VS_FILTER_FPM && t.altFt != null)
    .sort((a, b) => Math.abs(b.vertRateFpm) - Math.abs(a.vertRateFpm));
  const active = traffic.filter((t) => t.status !== "none");
  const cas = conflicts.filter((c) => c.state !== "resolved");
  const resolved = conflicts.filter((c) => c.state === "resolved").slice(-3).reverse();
  const hos = handoffs.filter((h) => h.state === "pending" || h.state === "overdue" || h.state === "unable");

  return (
    <>
      <section className="panel-sec">
        <h2>
          CONFLICT ALERTS <span className="count">{cas.length}</span>
        </h2>
        {cas.length === 0 && <div className="empty">No conflict alerts.</div>}
        {cas.map((c) => (
          <div key={c.id} className={`ca-row ca-${c.state}`} onClick={() => onPick(c.hexA)}>
            <div className="ca-top">
              <span className="ca-tag">CA</span>
              <b>
                {c.a} / {c.b}
              </b>
              <span className={`state st-${c.state}`}>{c.state.toUpperCase()}</span>
            </div>
            <div className="ca-sub">
              {c.predictedLatNm.toFixed(1)} NM / {Math.round(c.predictedVertFt)} ft in {Math.round(c.inSec)} s · {c.sectors[0]}/{c.sectors[1]}
            </div>
            {c.resolution && <div className="ca-res">{c.resolution}</div>}
          </div>
        ))}
        {resolved.map((c) => (
          <div key={c.id} className="ca-row ca-resolved">
            <div className="ca-top">
              <span className="ca-tag dim">CA</span>
              {c.a} / {c.b}
              <span className="state st-resolved">RESOLVED</span>
            </div>
            {c.resolution && <div className="ca-res">{c.resolution}</div>}
          </div>
        ))}
      </section>

      {hos.length > 0 && (
        <section className="panel-sec">
          <h2>HANDOFFS</h2>
          {hos.map((h) => (
            <div key={`${h.hex}-${h.startedAt}`} className={`ho-row ho-${h.state}`} onClick={() => onPick(h.hex)}>
              <b>{h.callsign}</b> {h.from} → {h.to} <span className={`state ho-${h.state}`}>{h.state.toUpperCase()}</span>
              {h.reason && <div className="ca-sub">{h.reason}</div>}
            </div>
          ))}
        </section>
      )}

      <section className="panel-sec">
        <h2>
          ACTIVE CLEARANCES <span className="count">{active.length}</span>
        </h2>
        {active.length === 0 && <div className="empty">No active clearances.</div>}
        {active.map((t) => (
          <div key={t.hex} className={`ac-row ${t.hex === selectedHex ? "sel" : ""}`} onClick={() => onPick(t.hex)}>
            <span className={`sw st-${t.status}`} />
            <b>{t.callsign}</b>
            <span className="dim">{altText(t.altFt)}</span>
            <span className={`stat st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
            <span className={`sec sec-${(trackControl[t.hex] ?? t.sector ?? "none").toLowerCase()}`}>{(trackControl[t.hex] ?? t.sector ?? "—")[0]}</span>
          </div>
        ))}
      </section>

      <section className="panel-sec">
        <h2>
          <label className="toggle">
            <input type="checkbox" checked={filterOn} onChange={(e) => setFilterOn(e.target.checked)} />
            <span className="tg-box" />
            CLIMBING / DESCENDING
          </label>
          <span className="count">{vs.length}</span>
        </h2>
        {filterOn &&
          (vs.length === 0 ? (
            <div className="empty">No aircraft climbing or descending over {VS_FILTER_FPM} fpm.</div>
          ) : (
            vs.map((t) => (
              <div key={t.hex} className={`vs-row ${t.hex === selectedHex ? "sel" : ""}`} onClick={() => onPick(t.hex)}>
                <b>{t.callsign}</b>
                <span>{altText(t.altFt)}</span>
                <span className={t.vertRateFpm > 0 ? "up" : "down"}>
                  {t.vertRateFpm > 0 ? "↑" : "↓"} {rateText(t.vertRateFpm)}
                </span>
              </div>
            ))
          ))}
      </section>
    </>
  );
}
