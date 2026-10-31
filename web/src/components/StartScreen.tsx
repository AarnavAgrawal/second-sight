// Airport picker: shown before an airport is chosen, and from the header's "Change airport".
import { useEffect, useRef, useState } from "react";
import type { Airport } from "@shared/types.ts";
import { lookupAirport, startSession } from "../api.ts";
import type { AirportSuggestion } from "../apiTypes.ts";

const QUICK = ["KSFO", "KLAX", "KJFK", "KATL", "KORD", "KDFW"];

interface Props {
  current: Airport | null;
  bridgeError: string | null;
  onStarted: (a: Airport) => void;
  onCancel: (() => void) | null;
}

export function StartScreen({ current, bridgeError, onStarted, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [match, setMatch] = useState<Airport | null>(null);
  const [suggestions, setSuggestions] = useState<AirportSuggestion[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqRef = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const c = code.trim().toUpperCase();
    setMatch(null);
    setSuggestions([]);
    setMsg(null);
    if (c.length < 3) return;
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await lookupAirport(c);
        if (id !== reqRef.current) return;
        if (r.ok) setMatch(r.airport);
        else {
          setSuggestions(r.suggestions);
          setMsg(r.error);
        }
      } catch {
        if (id === reqRef.current) setMsg("Bridge unreachable.");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [code]);

  const go = async (c: string) => {
    const icao = c.trim().toUpperCase();
    if (!icao || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await startSession(icao);
      if (r.airport) onStarted(r.airport);
      else setMsg(r.error ?? "Could not start session.");
    } catch {
      setMsg("Bridge unreachable. Is `bun run bridge` running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-brand">
          <span className="brand-mark" aria-hidden />
          SECOND SIGHT
        </div>
        <p className="start-sub">AI sector controllers on live ADS-B traffic. Pick the airspace to work.</p>
        <label className="start-label" htmlFor="apt">
          Enter a US airport code (e.g. KSFO)
        </label>
        <div className="start-row">
          <input
            id="apt"
            ref={inputRef}
            className="start-input"
            value={code}
            maxLength={4}
            spellCheck={false}
            autoComplete="off"
            placeholder="KSFO"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void go(match?.icao ?? code);
              if (e.key === "Escape" && onCancel) onCancel();
            }}
          />
          <button className="btn primary big" disabled={busy || code.trim().length < 3} onClick={() => void go(match?.icao ?? code)}>
            {busy ? "STARTING…" : "START"}
          </button>
        </div>
        <div className="start-result" aria-live="polite">
          {match && (
            <div className="match">
              <b>{match.icao}</b> {match.name}
              <span className="dim">
                {" "}
                · {match.city}
                {match.state ? `, ${match.state}` : ""} · elev {match.elevationFt.toLocaleString("en-US")} ft
              </span>
            </div>
          )}
          {!match && msg && <div className="nomatch">{msg}</div>}
          {!match && suggestions.length > 0 && (
            <div className="suggest">
              Did you mean
              {suggestions.map((s) => (
                <button key={s.icao} className="chip" onClick={() => setCode(s.icao)} title={`${s.name}, ${s.city}`}>
                  {s.icao} <span className="dim">{s.city}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="quick">
          {QUICK.map((q) => (
            <button key={q} className={`chip big ${current?.icao === q ? "on" : ""}`} disabled={busy} onClick={() => void go(q)}>
              {q}
            </button>
          ))}
        </div>
        {bridgeError && <div className="nomatch">Bridge: {bridgeError}</div>}
        <p className="start-note">Simulation layered on live traffic. Real aircraft do not receive these clearances.</p>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Back to {current?.icao} scope
          </button>
        )}
      </div>
    </div>
  );
}
