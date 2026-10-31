// Push-to-talk: hold to transmit, release to transcribe.
// Records with MediaRecorder and posts to the bridge /transcribe (Deepgram Nova-3 with keyterms).
// In parallel, runs the browser Web Speech API; its result is used only when /transcribe fails.
import { useCallback, useEffect, useRef, useState } from "react";
import { transcribe } from "./api.ts";

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type PttPhase = "idle" | "transmitting" | "transcribing";

export interface PushToTalk {
  phase: PttPhase;
  interim: string;
  error: string | null;
  source: "deepgram" | "webspeech" | null;
  start: () => void;
  stop: () => void;
  supported: boolean;
}

export function usePushToTalk(onTranscript: (text: string) => void, selectedHex: string | null): PushToTalk {
  const [phase, setPhase] = useState<PttPhase>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"deepgram" | "webspeech" | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recogRef = useRef<RecognitionLike | null>(null);
  const webTextRef = useRef("");
  const webDoneRef = useRef<Promise<void> | null>(null);
  const activeRef = useRef(false);
  const startedAtRef = useRef(0);
  const cbRef = useRef(onTranscript);
  const hexRef = useRef(selectedHex);
  cbRef.current = onTranscript;
  hexRef.current = selectedHex;

  const supported = typeof MediaRecorder !== "undefined" || recognitionCtor() !== null;

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    startedAtRef.current = Date.now();
    setError(null);
    setInterim("");
    setSource(null);
    setPhase("transmitting");
    chunksRef.current = [];
    webTextRef.current = "";

    // Web Speech in parallel (fallback transcript + live interim text).
    const Ctor = recognitionCtor();
    if (Ctor) {
      try {
        const r = new Ctor();
        r.lang = "en-US";
        r.continuous = true;
        r.interimResults = true;
        let finalText = "";
        r.onresult = (e) => {
          let interimText = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i]!;
            if (res.isFinal) finalText += `${res[0].transcript} `;
            else interimText += res[0].transcript;
          }
          webTextRef.current = (finalText + interimText).trim();
          setInterim(webTextRef.current);
        };
        webDoneRef.current = new Promise<void>((resolve) => {
          r.onend = () => resolve();
          r.onerror = () => resolve();
        });
        r.start();
        recogRef.current = r;
      } catch {
        recogRef.current = null;
        webDoneRef.current = null;
      }
    }

    // MediaRecorder for Deepgram.
    if (typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      const begin = (stream: MediaStream) => {
        if (!activeRef.current) return;
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        rec.ondataavailable = (e) => {
          if (e.data.size) chunksRef.current.push(e.data);
        };
        rec.start();
        recorderRef.current = rec;
      };
      if (streamRef.current && streamRef.current.active) begin(streamRef.current);
      else
        navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
          .then((s) => {
            streamRef.current = s;
            begin(s);
          })
          .catch(() => setError("Microphone unavailable. Type the clearance instead."));
    }
  }, []);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const heldMs = Date.now() - startedAtRef.current;
    const rec = recorderRef.current;
    recorderRef.current = null;
    const recog = recogRef.current;
    recogRef.current = null;
    setPhase("transcribing");

    const recorded = new Promise<Blob | null>((resolve) => {
      if (!rec || rec.state === "inactive") return resolve(null);
      rec.onstop = () => resolve(chunksRef.current.length ? new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }) : null);
      rec.stop();
    });
    try {
      recog?.stop();
    } catch {
      /* ignore */
    }

    void (async () => {
      if (heldMs < 350) {
        recog?.abort();
        setPhase("idle");
        setError("Hold to transmit, release when done.");
        return;
      }
      const blob = await recorded;
      let text: string | null = null;
      if (blob) {
        text = await transcribe(blob, hexRef.current);
        if (text) setSource("deepgram");
      }
      if (!text) {
        // Fallback: wait briefly for the Web Speech final result.
        if (webDoneRef.current) await Promise.race([webDoneRef.current, new Promise((r) => setTimeout(r, 1500))]);
        text = webTextRef.current.trim() || null;
        if (text) setSource("webspeech");
      }
      setPhase("idle");
      if (!text) {
        setError("No speech recognized. Say again, or type the clearance.");
        return;
      }
      setInterim(text);
      cbRef.current(text);
    })();
  }, []);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return { phase, interim, error, source, start, stop, supported };
}
