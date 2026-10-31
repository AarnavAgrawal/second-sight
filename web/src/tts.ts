// Spoken replies from the sector controllers. Clips are queued so they never overlap.
// Uses the bridge /speak (Deepgram Aura-2) and falls back to the browser speechSynthesis.
import { speak } from "./api.ts";

interface Clip {
  text: string;
  voice?: string;
}

const queue: Clip[] = [];
const recent = new Map<string, number>();
let playing = false;
let muted = false;
let current: HTMLAudioElement | null = null;

export function setMuted(m: boolean) {
  muted = m;
  if (m) {
    queue.length = 0;
    current?.pause();
    current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}

/** Queue a line to be spoken. Duplicate text within 60 s is dropped (feed + clearance reply can both carry it). */
export function say(text: string, voice?: string) {
  if (muted || !text.trim()) return;
  const key = text.trim().toLowerCase();
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > 60000) recent.delete(k);
  if (recent.has(key)) return;
  recent.set(key, now);
  queue.push({ text, voice });
  void pump();
}

async function pump() {
  if (playing) return;
  playing = true;
  try {
    while (queue.length && !muted) {
      const clip = queue.shift()!;
      await playClip(clip);
    }
  } finally {
    playing = false;
  }
}

async function playClip(clip: Clip) {
  const blob = await speak(clip.text, clip.voice);
  if (muted) return;
  if (blob) {
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve) => {
        const audio = new Audio(url);
        current = audio;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
      });
      return;
    } finally {
      current = null;
      URL.revokeObjectURL(url);
    }
  }
  await speakBrowser(clip);
}

function speakBrowser(clip: Clip): Promise<void> {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clip.text);
    u.rate = 1.08;
    // Give each sector a slightly different voice so NORTH and SOUTH sound different.
    u.pitch = clip.voice === "SOUTH" ? 0.85 : clip.voice === "MONITOR" ? 1.15 : 1;
    const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    if (voices.length) {
      const idx = clip.voice === "SOUTH" ? 1 : clip.voice === "MONITOR" ? 2 : 0;
      u.voice = voices[idx % voices.length]!;
    }
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
    // Safety: never block the queue forever.
    setTimeout(resolve, 15000);
  });
}
