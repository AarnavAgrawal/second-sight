// Shadow evaluation: what the real controller said (heard on the frequency), what Second Sight would have
// ruled at that moment, and what the aircraft actually did (recorded ADS-B). Data from GET /eval/:icao.
import { useEffect, useMemo, useState } from "react";
import type { ClearanceEval, ConflictEval, EvalReport, OutcomeResult } from "@shared/types.ts";
import { BRIDGE_URL } from "../api.ts";

const hhmm = (ts: number) => new Date(ts).toISOString().slice(11, 16) + "Z";
const hhmmss = (ts: number) => new Date(ts).toISOString().slice(11, 19) + "Z";
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
const alt = (ft: number) => (ft >= 18_000 ? `FL${Math.round(ft / 100)}` : ft.toLocaleString("en-US"));
const reqText = (c: ClearanceEval["req"]) =>
  c.kind === "altitude" ? `ALT ${alt(c.value)}` : `HDG ${String(c.value).padStart(3, "0")}${c.turn ? ` ${c.turn[0]!.toUpperCase()}` : ""}`;

const OUTCOME_LABEL: Record<OutcomeResult, string> = {
  complied: "COMPLIED",
  in_progress: "IN PROGRESS",
  no_change: "NO CHANGE",
  contrary: "CONTRARY",
  no_data: "NO ADS-B",
};

type ClrFilter = "all" | "unable" | "not_complied";

export function EvalDashboard({ icao }: { icao: string }) {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [full, setFull] = useState<EvalReport | null>(null);
  const [filter, setFilter] = useState<ClrFilter>("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stop = false;
    setLoading(true);
    const q = range ? `?from=${range.from}&to=${range.to}` : "";
    fetch(`${BRIDGE_URL}/eval/${icao}${q}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `Bridge error ${r.status}`);
        return body as EvalReport;
      })
      .then((r) => {
        if (stop) return;
        setReport(r);
        setError(null);
        if (!range) setFull(r);
      })
      .catch((e) => !stop && setError((e as Error).message))
      .finally(() => !stop && setLoading(false));
    return () => {
      stop = true;
    };
  }, [icao, range]);

  const rows = useMemo(() => {
    const list = report?.clearances.filter((c) => c.ruling) ?? [];
    if (filter === "unable") return list.filter((c) => c.ruling?.decision === "unable");
    if (filter === "not_complied") return list.filter((c) => c.outcome.result !== "complied");
    return list;
  }, [report, filter]);

  return (
    <div className="eval">
      <header className="eval-hdr">
        <a className="btn" href="#/">
          ← Scope
        </a>
        <div>
          <div className="eval-title">Shadow evaluation · {icao}</div>
          <div className="eval-sub">
            Real controller (NorCal Approach audio, LiveATC archive) vs Second Sight's ruling at the same moment vs what the aircraft
            flew (recorded ADS-B). Nothing here was transmitted.
          </div>
        </div>
        {loading && <span className="dim">Loading…</span>}
      </header>

      {error && <div className="eval-error">{error}</div>}
      {full && <Timeline full={full} range={range} setRange={setRange} />}
      {report && (
        <>
          <Kpis r={report} />
          <section className="eval-sec">
            <div className="eval-sec-hdr">
              <h2>Controller clearances, scored</h2>
              <div className="chips">
                {(
                  [
                    ["all", "All"],
                    ["unable", "Second Sight: unable"],
                    ["not_complied", "Aircraft did not comply"],
                  ] as [ClrFilter, string][]
                ).map(([k, label]) => (
                  <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <table className="eval-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Aircraft</th>
                  <th>Controller said</th>
                  <th>Second Sight would</th>
                  <th>Aircraft did</th>
                  <th>Altitude −60 s … +4 min</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <ClearanceRow key={c.id} c={c} />
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="dim">
                      No scored clearances in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <Conflicts list={report.conflicts} />
          <Method r={report} />
        </>
      )}
    </div>
  );
}

function Timeline({ full, range, setRange }: { full: EvalReport; range: { from: number; to: number } | null; setRange: (r: { from: number; to: number } | null) => void }) {
  const bins = full.bins;
  const max = Math.max(1, ...bins.map((b) => b.heard));
  const binMs = bins.length > 1 ? bins[1]!.ts - bins[0]!.ts : 5 * 60_000;
  const adsbFrom = full.span.adsbFrom ?? 0;
  const sel = (ts: number) => !!range && ts >= range.from && ts < range.to;
  const click = (ts: number, shift: boolean) => {
    if (shift && range) setRange({ from: Math.min(range.from, ts), to: Math.max(range.to, ts + binMs) });
    else setRange({ from: ts, to: ts + binMs });
  };
  return (
    <section className="eval-sec">
      <div className="eval-sec-hdr">
        <h2>
          Range: {hhmm(range?.from ?? full.fromTs)} – {hhmm(range?.to ?? full.toTs)}
        </h2>
        <div className="chips">
          <button className={`chip ${range ? "" : "on"}`} onClick={() => setRange(null)}>
            Whole recording
          </button>
          <span className="dim small">Click a bar for 5 min, shift-click to extend.</span>
        </div>
      </div>
      <div className="timeline" role="img" aria-label="Transmissions per 5 minutes">
        {bins.map((b) => {
          const noAdsb = b.ts + binMs <= adsbFrom;
          return (
            <button key={b.ts} className={`tl-bin ${sel(b.ts) ? "sel" : ""}`} onClick={(e) => click(b.ts, e.shiftKey)} title={`${hhmm(b.ts)}: ${b.heard} heard, ${b.clearances} scored, ${b.unable} unable`}>
              <span className="tl-bars">
                <span className={`tl-heard ${noAdsb ? "noadsb" : ""}`} style={{ height: `${(b.heard / max) * 100}%` }}>
                  <span className="tl-clr" style={{ height: `${b.heard ? (b.clearances / b.heard) * 100 : 0}%` }} />
                </span>
                {b.unable > 0 && <span className="tl-unable" style={{ bottom: `${(b.heard / max) * 100}%` }} />}
              </span>
              <span className="tl-label">{hhmm(b.ts)}</span>
            </button>
          );
        })}
      </div>
      <div className="legend-row small">
        <span>
          <i className="sw sw-heard" /> transmissions heard
        </span>
        <span>
          <i className="sw sw-clr" /> scored clearances
        </span>
        <span>
          <i className="sw sw-unable" /> Second Sight would say unable
        </span>
        <span>
          <i className="sw sw-noadsb" /> before ADS-B recording started ({hhmm(adsbFrom)})
        </span>
      </div>
    </section>
  );
}

function Kpis({ r }: { r: EvalReport }) {
  const { coverage: cv, kpis: k } = r;
  const scored = k.issue + k.coordinate + k.unable;
  return (
    <section className="kpis">
      <div className="kpi">
        <div className="kpi-label">Controller clearances heard</div>
        <div className="kpi-value">{cv.controllerClearances}</div>
        <div className="kpi-note">
          {cv.matched} of {cv.duringAdsb} heard while ADS-B was recording matched to an aircraft ({pct(cv.matched, cv.duringAdsb)}) · {cv.withAdsb} scored
          {cv.implausible ? ` · ${cv.implausible} unreadable values dropped` : ""}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Aircraft complied</div>
        <div className="kpi-value ok">{pct(k.complied, k.outcomeKnown)}</div>
        <div className="kpi-note">
          {k.complied} of {k.outcomeKnown} with an observable outcome. Checks that the pipeline heard the controller right.
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Second Sight agreed</div>
        <div className="kpi-value ok">{pct(k.agreed, scored)}</div>
        <div className="kpi-note">
          Would have issued the controller's clearance ({k.issue} directly, {k.coordinate} after coordinating) and the aircraft flew it: {k.agreed} of {scored}.
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Second Sight: unable</div>
        <div className="kpi-value warn">{k.unable}</div>
        <div className="kpi-note">Controller clearances our probe would have refused. Each is either a real hazard or our probe being stricter than a human.</div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Conflict alerts (replayed)</div>
        <div className="kpi-value">{k.conflicts}</div>
        <div className="kpi-note">
          {k.conflictsWithLoS} got inside 3 NM / 1,000 ft · controller cleared one of the pair in {k.conflictsControllerActed} ({pct(k.conflictsControllerActed, k.conflicts)})
        </div>
      </div>
    </section>
  );
}

function ClearanceRow({ c }: { c: ClearanceEval }) {
  const r = c.ruling!;
  return (
    <tr>
      <td className="mono">{hhmmss(c.ts)}</td>
      <td className="mono">
        <b>{c.callsign}</b>
        {c.before && (
          <div className="dim small">
            {c.before.altFt != null ? alt(c.before.altFt) : "—"} · {String(c.before.magTrackDeg).padStart(3, "0")}° · {r.phase}
          </div>
        )}
      </td>
      <td>
        <span className="tag">{reqText(c.req)}</span>
        <div className="quote">“{c.text}”</div>
      </td>
      <td>
        <span className={`tag d-${r.decision}`}>{r.decision.toUpperCase()}</span>
        {r.decision !== "issue" && <div className="small">{r.reason}</div>}
        {r.alternative && <div className="small dim">Suggest: {r.alternative}</div>}
      </td>
      <td>
        <span className={`tag o-${c.outcome.result}`}>{OUTCOME_LABEL[c.outcome.result]}</span>
        <div className="small">{c.outcome.detail}</div>
      </td>
      <td>
        <Spark c={c} />
      </td>
    </tr>
  );
}

/** Altitude over time around the clearance; dashed line = cleared altitude, vertical line = when it was heard. */
function Spark({ c }: { c: ClearanceEval }) {
  const pts = c.track.filter((p) => p.altFt != null) as { t: number; altFt: number }[];
  if (pts.length < 2) return <span className="dim small">no track</span>;
  const W = 180;
  const H = 46;
  const t0 = -60;
  const t1 = 240;
  const alts = pts.map((p) => p.altFt).concat(c.req.kind === "altitude" ? [c.req.value] : []);
  const lo = Math.min(...alts) - 200;
  const hi = Math.max(...alts) + 200;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (a: number) => H - ((a - lo) / (hi - lo)) * H;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.altFt).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} className="spark" role="img" aria-label="Altitude around the clearance">
      <line x1={x(0)} x2={x(0)} y1={0} y2={H} className="sp-now" />
      {c.req.kind === "altitude" && <line x1={0} x2={W} y1={y(c.req.value)} y2={y(c.req.value)} className="sp-target" />}
      <path d={d} className={`sp-line o-${c.outcome.result}`} />
    </svg>
  );
}

function Conflicts({ list }: { list: ConflictEval[] }) {
  const [onlyLoS, setOnlyLoS] = useState(false);
  const rows = (onlyLoS ? list.filter((c) => c.actualLoS) : list).slice(0, 200);
  return (
    <section className="eval-sec">
      <div className="eval-sec-hdr">
        <h2>Conflict alerts replayed on recorded traffic</h2>
        <div className="chips">
          <button className={`chip ${onlyLoS ? "" : "on"}`} onClick={() => setOnlyLoS(false)}>
            All ({list.length})
          </button>
          <button className={`chip ${onlyLoS ? "on" : ""}`} onClick={() => setOnlyLoS(true)}>
            Got inside minima ({list.filter((c) => c.actualLoS).length})
          </button>
        </div>
      </div>
      <table className="eval-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Pair</th>
            <th>Second Sight predicted</th>
            <th>Actual closest (next 150 s)</th>
            <th>Controller</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="mono">{hhmmss(c.ts)}</td>
              <td className="mono">
                <b>{c.a}</b> / <b>{c.b}</b>
              </td>
              <td className="mono">
                {c.predictedLatNm} NM / {c.predictedVertFt} ft in {c.predictedInSec} s
              </td>
              <td className="mono">
                {c.actualMinLatNm == null ? (
                  <span className="dim">left the recording</span>
                ) : (
                  <>
                    {c.actualMinLatNm} NM / {c.actualVertAtMinFt ?? "—"} ft{" "}
                    {c.actualLoS ? <span className="tag o-contrary">INSIDE MINIMA</span> : <span className="tag o-complied">SEPARATED</span>}
                  </>
                )}
              </td>
              <td>
                {c.controllerActed ? (
                  <>
                    <span className="tag d-issue">CLEARED {c.actedAfterSec! >= 0 ? `+${c.actedAfterSec}` : c.actedAfterSec} s</span>
                    <div className="quote small">“{c.actedText}”</div>
                  </>
                ) : (
                  <span className="dim small">no clearance heard to either</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Method({ r }: { r: EvalReport }) {
  return (
    <section className="eval-sec method small">
      <h2>How this is measured</h2>
      <ul>
        <li>
          <b>Heard:</b> {r.coverage.heard} transmissions split at squelch gaps and transcribed (gpt-4o-transcribe) in a Superserve sandbox, then parsed
          into speaker, callsign and clearance. Callsigns are matched against everything on ADS-B within ±150 s: the parser's pick is kept only if it fits the spoken airline and flight number, then a deterministic matcher (group-form numbers, one-digit slips, abbreviated callsigns, pilot readbacks) fills the rest. Unmatched ones are not scored.
        </li>
        <li>
          <b>Second Sight would:</b> the same facts packet the sector agents get (probe, safe candidates, flight phase, recent clearance, sector entry),
          decided by the agents' deterministic policy. The live agents can pick a different safe candidate; they cannot approve what the probe refuses.
        </li>
        <li>
          <b>Aircraft did:</b> recorded ADS-B within 4 min (altitude, ±300 ft) or 2 min (heading, ±20° magnetic track) after the clearance.
        </li>
        <li>
          <b>Conflict alerts</b> use the live rules (IFR only, terminal filters). "Inside minima" means inside 3 NM and 1,000 ft. Parallel approaches
          and visual separation legitimately go inside radar minima, so this is not a count of losses of separation.
        </li>
        <li>Assists a controller, does not replace one. The real aircraft never heard Second Sight.</li>
      </ul>
    </section>
  );
}
