import { useEffect, useState } from "react";
import type { Airport } from "@shared/types.ts";
import { zulu } from "../format.ts";

interface Props {
  airport: Airport | null;
  count: number;
  dataSource: "live" | "replay" | null;
  connected: boolean;
  muted: boolean;
  setMuted: (m: boolean) => void;
  onChangeAirport: () => void;
  mock: boolean;
}

export function Header({ airport, count, dataSource, connected, muted, setMuted, onChangeAirport, mock }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="hdr">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <div>
          <div className="brand-name">SECOND SIGHT</div>
          <div className="brand-note">Simulation layered on live traffic. Real aircraft do not receive these clearances.</div>
        </div>
      </div>
      <div className="hdr-apt">
        {airport ? (
          <>
            <span className="apt-code">{airport.icao}</span>
            <span className="apt-name">{airport.name}</span>
          </>
        ) : (
          <span className="apt-name dim">No airport selected</span>
        )}
      </div>
      <div className="hdr-right">
        <span className="stat-pill">
          <b>{count}</b> AIRCRAFT
        </span>
        {dataSource && <span className={`badge ${dataSource}`}>{dataSource === "replay" ? "REPLAY" : "LIVE"}</span>}
        {mock && <span className="badge mock">MOCK</span>}
        <span className={`conn ${connected ? "up" : "down"}`} title={connected ? "Connected to Airspace actor" : "Reconnecting"}>
          {connected ? "●" : "○"}
        </span>
        <span className="zulu">{zulu(now)}</span>
        <button className={`btn ${muted ? "" : "on"}`} onClick={() => setMuted(!muted)} aria-pressed={!muted} title="Spoken controller replies">
          {muted ? "VOICE OFF" : "VOICE ON"}
        </button>
        <button className="btn" onClick={onChangeAirport}>
          Change airport
        </button>
      </div>
    </header>
  );
}
