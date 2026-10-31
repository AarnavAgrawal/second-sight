// Live Agent Relay feed mirrored into Airspace.feed, with channel filters and CIC input.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FeedItem } from "@shared/types.ts";
import { postCic } from "../api.ts";
import { clock } from "../format.ts";

const FILTERS = ["ALL", "#radar", "#coord", "#alerts", "#cic", "DM"] as const;
type Filter = (typeof FILTERS)[number];

const senderClass = (from: string) => {
  const f = from.toUpperCase();
  if (f.includes("NORTH")) return "from-north";
  if (f.includes("SOUTH")) return "from-south";
  if (f.includes("MONITOR")) return "from-monitor";
  if (f.includes("CIC")) return "from-cic";
  if (f.includes("RADAR")) return "from-radar";
  return "from-other";
};

export function FeedPanel({ feed, observerUrl }: { feed: FeedItem[]; observerUrl?: string }) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const shown = feed.filter((f) => {
    if (filter === "ALL") return true;
    if (filter === "DM") return !f.to.startsWith("#");
    return f.to === filter;
  });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, filter, shown[shown.length - 1]?.ts]);

  useEffect(() => {
    stickRef.current = true;
  }, [filter]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setErr(null);
    try {
      const ok = await postCic(t);
      if (ok) setText("");
      else setErr("Not sent.");
    } catch {
      setErr("Bridge unreachable.");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="panel right">
      <div className="feed-head">
        <h2>RELAY FEED</h2>
        {observerUrl && (
          <a className="observer" href={observerUrl} target="_blank" rel="noreferrer">
            Observer ↗
          </a>
        )}
      </div>
      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <div
        className="feed"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.length === 0 && <div className="empty">No messages.</div>}
        {shown.map((f, i) => (
          <div key={`${f.ts}-${i}-${f.from}`} className={`fi ${senderClass(f.from)}`}>
            <div className="fi-meta">
              <span className="fi-time">{clock(f.ts)}</span>
              <span className="fi-from">{f.from}</span>
              <span className="fi-arrow">→</span>
              <span className={`fi-to ${f.to.startsWith("#") ? "chan" : "dm"}`}>{f.to}</span>
            </div>
            <div className="fi-text">{f.text}</div>
          </div>
        ))}
      </div>
      <form
        className="cic-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span className="cic-tag">CIC → #cic</span>
        <div className="cic-row">
          <input
            className="cic-input"
            value={text}
            placeholder="SOUTH, stop accepting handoffs for two minutes"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
          />
          <button className="btn" type="submit" disabled={!text.trim() || sending}>
            POST
          </button>
        </div>
        {err && <div className="ptt-err">{err}</div>}
      </form>
    </aside>
  );
}
