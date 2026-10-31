// Clearance entry: push-to-talk (button or held spacebar) and typed text.
// Shows the loop: transcript → phraseology echo → probe and sector review steps → issued or Unable.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TrafficEntry } from "@shared/types.ts";
import { sendClearance } from "../api.ts";
import type { ClearanceResponse, StepId } from "../apiTypes.ts";
import { say } from "../tts.ts";
import { usePushToTalk } from "../usePushToTalk.ts";

const STEP_LABEL: Record<StepId, string> = {
  parse: "PARSE",
  resolve: "CALLSIGN",
  probe: "PROBE",
  sectorReview: "SECTOR",
  issue: "ISSUE",
};

interface Props {
  draft: string;
  setDraft: (s: string) => void;
  selected: TrafficEntry | null;
  focusToken: number;
}

interface Exchange {
  text: string;
  via: "voice" | "text" | "alternative" | "override";
  busy: boolean;
  res: ClearanceResponse | null;
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function ClearancePanel({ draft, setDraft, selected, focusToken }: Props) {
  const [ex, setEx] = useState<Exchange | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus();
  }, [focusToken]);

  const submit = useCallback(async (text: string, via: Exchange["via"], override = false) => {
    const t = text.trim();
    if (!t) return;
    const id = ++seqRef.current;
    setEx({ text: t, via, busy: true, res: null });
    let res: ClearanceResponse;
    try {
      res = await sendClearance(t, override);
    } catch {
      res = { issued: false, transcript: t, steps: [], reason: "Bridge unreachable. Clearance not issued." };
    }
    if (id !== seqRef.current) return;
    setEx({ text: t, via, busy: false, res });
    if (!res.issued && res.reason && res.sector && !res.sayAgain) say(res.reason, res.sector);
  }, []);

  const ptt = usePushToTalk((text) => void submit(text, "voice"), selected?.hex ?? null);

  // Hold spacebar to transmit (ignored while typing in a text field).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      if (!e.repeat) ptt.start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      ptt.stop();
    };
    const blur = () => ptt.stop();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [ptt.start, ptt.stop]); // eslint-disable-line react-hooks/exhaustive-deps

  const res = ex?.res ?? null;
  const transmitting = ptt.phase === "transmitting";

  return (
    <section className="panel-sec clearance">
      <h2>CLEARANCE</h2>
      <button
        className={`ptt ${transmitting ? "tx" : ""} ${ptt.phase === "transcribing" ? "rx" : ""}`}
        onPointerDown={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          ptt.start();
        }}
        onPointerUp={() => ptt.stop()}
        onPointerCancel={() => ptt.stop()}
        onContextMenu={(e) => e.preventDefault()}
        disabled={!ptt.supported}
      >
        <span className="ptt-dot" />
        {transmitting ? "TRANSMITTING" : ptt.phase === "transcribing" ? "TRANSCRIBING…" : "HOLD TO TALK"}
        <span className="ptt-key">SPACE</span>
      </button>
      {(transmitting || ptt.phase === "transcribing") && ptt.interim && <div className="interim">“{ptt.interim}”</div>}
      {ptt.error && ptt.phase === "idle" && <div className="ptt-err">{ptt.error}</div>}

      <form
        className="clr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(draft, "text");
          setDraft("");
        }}
      >
        <input
          ref={inputRef}
          className="clr-input"
          value={draft}
          spellCheck={false}
          placeholder={selected ? `${selected.callsign}, climb and maintain…` : "United one twenty-three, climb and maintain eight thousand"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
        <button className="btn primary" type="submit" disabled={!draft.trim() || ex?.busy}>
          SEND
        </button>
      </form>

      {ex && (
        <div className={`exchange ${ex.busy ? "busy" : res?.issued ? "ok" : "bad"}`}>
          <div className="ex-transcript">
            <span className="tag">{ex.via === "voice" ? `VOICE${ptt.source === "webspeech" ? " · WEB SPEECH" : ""}` : ex.via.toUpperCase()}</span>
            <span className="quote">“{res?.transcript || ex.text}”</span>
          </div>
          {res?.phraseology && <div className="echo">{res.phraseology}</div>}
          {ex.busy && <div className="probing">PROBING · SECTOR REVIEW…</div>}
          {res && res.steps.length > 0 && (
            <ol className="steps">
              {res.steps.map((s) => (
                <li key={s.id} className={`step ${s.status}`}>
                  <span className="mark">{s.status === "ok" ? "✓" : s.status === "fail" ? "✗" : "–"}</span>
                  <span className="sid">{STEP_LABEL[s.id] ?? s.id}</span>
                  <span className="sdetail">{s.detail}</span>
                  <span className="sms">{s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${Math.round(s.ms)} ms`}</span>
                </li>
              ))}
            </ol>
          )}
          {res?.issued && (
            <div className="issued">
              {res.override ? "ISSUED · CIC OVERRIDE" : `ISSUED${res.sector ? ` BY ${res.sector}` : ""}`}
              {res.override && res.probe && !res.probe.ok && <ProbeWarnings res={res} />}
            </div>
          )}
          {res && !res.issued && res.sayAgain && (
            <div className="sayagain">
              <div className="unable-head">SAY AGAIN</div>
              <div className="unable-reason">{res.reason ?? "Clearance not understood."}</div>
              {res.suggestions && res.suggestions.length > 0 && (
                <div className="suggest">
                  {res.suggestions.map((s) => (
                    <button key={s} className="chip" onClick={() => setDraft(`${s}, `)}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {res && !res.issued && !res.sayAgain && (
            <div className="unable">
              <div className="unable-head">UNABLE{res.sector ? ` · ${res.sector}` : ""}</div>
              <div className="unable-reason">{res.reason ?? "Clearance not issued."}</div>
              <ProbeWarnings res={res} />
              <div className="unable-actions">
                {res.alternative && (
                  <button className="btn primary" onClick={() => void submit(res.alternative!.text, "alternative")}>
                    ISSUE ALTERNATIVE · {res.alternative.text}
                  </button>
                )}
                {res.parsed && (
                  <button className="btn warn small" onClick={() => void submit(ex.text, "override", true)}>
                    CIC override
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ProbeWarnings({ res }: { res: ClearanceResponse }) {
  const p = res.probe;
  if (!p || p.ok) return null;
  return (
    <ul className="probe-warn">
      {p.reasons.map((r, i) => (
        <li key={`r${i}`}>{r}</li>
      ))}
      {p.conflicts
        .filter((c) => !p.reasons.some((r) => r.includes(c.with)))
        .map((c, i) => (
          <li key={`c${i}`}>
            Traffic {c.with}: {c.minLatNm.toFixed(1)} NM / {Math.round(c.minVertFt)} ft in {Math.round(c.inSec)} s
          </li>
        ))}
    </ul>
  );
}
