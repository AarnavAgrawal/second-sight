import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlertItem } from "@shared/types.ts";
import { BRIDGE_URL, MOCK, getConfig } from "./api.ts";
import type { AirspaceState, BridgeConfig } from "./apiTypes.ts";
import { ClearancePanel } from "./components/ClearancePanel.tsx";
import { DetailCard } from "./components/DetailCard.tsx";
import { FeedPanel } from "./components/FeedPanel.tsx";
import { Header } from "./components/Header.tsx";
import { Scope } from "./components/Scope.tsx";
import { StartScreen } from "./components/StartScreen.tsx";
import { TrafficLists, VS_FILTER_FPM } from "./components/TrafficLists.tsx";
import { say, setMuted as setTtsMuted } from "./tts.ts";
import { useActor } from "./useActor.ts";

const SPEAKERS = new Set(["NORTH", "SOUTH", "MONITOR"]);
const QUIET_AFTER_MS = 20000;
const TOAST_MS = 12000;

const feedKey = (f: { ts: number; from: string; text: string }) => `${f.ts}|${f.from}|${f.text}`;
const alertKey = (a: AlertItem) => `${a.ts}|${a.kind}|${a.text}`;

export function App() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const airspace = useActor<AirspaceState>("Airspace", "main");
  const st = airspace.state;
  const airport = st?.airport ?? null;
  const traffic = st?.traffic ?? [];
  const trackControl = st?.trackControl ?? {};
  const handoffs = st?.handoffs ?? [];
  const conflicts = st?.conflicts ?? [];
  const feed = st?.feed ?? [];
  const alerts = st?.alerts ?? [];

  const [showPicker, setShowPicker] = useState(false);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [focusToken, setFocusToken] = useState(0);
  const [filterOn, setFilterOn] = useState(false);
  const [muted, setMutedState] = useState(MOCK);
  const [quietArmed, setQuietArmed] = useState(false);
  const [toasts, setToasts] = useState<(AlertItem & { key: string })[]>([]);

  // Bridge config (retry until it answers; it only changes on bridge restart).
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const c = await getConfig();
        if (!stop) setConfig(c);
      } catch {
        if (!stop) t = setTimeout(load, 3000);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    setTtsMuted(m);
  }, []);
  useEffect(() => setTtsMuted(MOCK), []);

  // "Quiet airspace" check 20 s after an airport is set.
  useEffect(() => {
    setQuietArmed(false);
    setSelectedHex(null);
    if (!airport) return;
    const t = setTimeout(() => setQuietArmed(true), QUIET_AFTER_MS);
    return () => clearTimeout(t);
  }, [airport?.icao]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speak new sector controller messages addressed to the CIC (never the backlog from the initial snapshot).
  const seenFeed = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!st) return;
    const first = seenFeed.current === null;
    const seen = seenFeed.current ?? new Set<string>();
    const now = Date.now();
    for (const f of feed) {
      const k = feedKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      if (first || now - f.ts > 20000) continue;
      const to = f.to.toUpperCase();
      if ((to === "#CIC" || to === "CIC") && SPEAKERS.has(f.from.toUpperCase())) say(f.text, f.from.toUpperCase());
    }
    seenFeed.current = seen;
  }, [feed, st]);

  // Alert toasts for alerts that arrive while the scope is open.
  const seenAlerts = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!st) return;
    const first = seenAlerts.current === null;
    const seen = seenAlerts.current ?? new Set<string>();
    const fresh: (AlertItem & { key: string })[] = [];
    for (const a of alerts) {
      const k = alertKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!first && Date.now() - a.ts < 30000) fresh.push({ ...a, key: k });
    }
    seenAlerts.current = seen;
    if (fresh.length) setToasts((t) => [...t, ...fresh].slice(-4));
  }, [alerts, st]);
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((ts) => ts.slice(1)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  const selected = useMemo(() => traffic.find((t) => t.hex === selectedHex) ?? null, [traffic, selectedHex]);
  const highlight = useMemo(
    () => (filterOn ? new Set(traffic.filter((t) => Math.abs(t.vertRateFpm) > VS_FILTER_FPM).map((t) => t.hex)) : null),
    [filterOn, traffic],
  );

  const pick = useCallback(
    (hex: string) => {
      setSelectedHex(hex);
      const t = traffic.find((x) => x.hex === hex);
      if (t?.callsign) setDraft(`${t.callsign}, `);
    },
    [traffic],
  );

  const pickerOpen = (st !== null && !airport) || showPicker || (st === null && airspace.error !== null);
  const connecting = st === null && airspace.error === null;
  const quiet = quietArmed && airport && traffic.length < 5;

  return (
    <div className="app">
      <Header
        airport={airport}
        count={traffic.length}
        dataSource={config?.dataSource ?? null}
        connected={airspace.connected}
        muted={muted}
        setMuted={setMuted}
        onChangeAirport={() => setShowPicker(true)}
        mock={MOCK}
      />
      <main className="grid">
        <aside className="panel left">
          <ClearancePanel draft={draft} setDraft={setDraft} selected={selected} focusToken={focusToken} />
          <TrafficLists
            traffic={traffic}
            conflicts={conflicts}
            handoffs={handoffs}
            trackControl={trackControl}
            selectedHex={selectedHex}
            filterOn={filterOn}
            setFilterOn={setFilterOn}
            onPick={pick}
          />
        </aside>
        <section className="scope">
          <Scope
            airport={airport}
            radiusNm={airport?.radiusNm ?? config?.radiusNm ?? 35}
            traffic={traffic}
            trackControl={trackControl}
            handoffs={handoffs}
            conflicts={conflicts}
            selectedHex={selectedHex}
            highlight={highlight}
            onSelect={setSelectedHex}
          />
          <div className="toasts">
            {toasts.map((t) => (
              <div key={t.key} className={`toast k-${t.kind}`}>
                <b>{t.kind.replace("_", " ")}</b> {t.text}
              </div>
            ))}
          </div>
          {quiet && <div className="quiet">Quiet airspace. Try a busier airport.</div>}
          {airspace.error && st && <div className="quiet warn">Reconnecting to Airspace actor…</div>}
          {selected && (
            <DetailCard
              key={selected.hex}
              entry={selected}
              sector={trackControl[selected.hex] ?? selected.sector}
              declinationDeg={airport?.declinationDeg ?? 0}
              onClose={() => setSelectedHex(null)}
              onClear={(hex) => {
                pick(hex);
                setFocusToken((n) => n + 1);
              }}
            />
          )}
          <Legend />
          {connecting && <div className="connecting">Connecting to bridge at {MOCK ? "mock" : BRIDGE_URL}…</div>}
        </section>
        <FeedPanel feed={feed} observerUrl={config?.relayObserverUrl} />
      </main>
      {pickerOpen && (
        <StartScreen
          current={airport}
          bridgeError={st === null ? airspace.error : null}
          onStarted={() => {
            setShowPicker(false);
            setSelectedHex(null);
          }}
          onCancel={airport ? () => setShowPicker(false) : null}
        />
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span className="lg st-none">NONE</span>
      <span className="lg st-pending">PENDING</span>
      <span className="lg st-conforming">CONFORMING</span>
      <span className="lg st-non_conforming">NON-CONF</span>
      <span className="lg st-coasting">CST</span>
      <span className="lg sec-north">N NORTH</span>
      <span className="lg sec-south">S SOUTH</span>
    </div>
  );
}
