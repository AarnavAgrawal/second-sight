// Subscribe to a Terse actor's emitted state over a websocket opened with a /grant URL.
// Applies `state` (full snapshot) then `state_update` (shallow merge of changed fields, delete removed).
// Reconnects with a fresh grant and exponential backoff (max 5 s). No polling.
import { useEffect, useState } from "react";
import { getGrant, openSocket, type SocketLike } from "./api.ts";
import type { ActorMessage, ActorName } from "./apiTypes.ts";

export interface ActorSubscription<T> {
  state: T | null;
  connected: boolean;
  error: string | null;
}

export function useActor<T extends object>(actor: ActorName, id: string | null): ActorSubscription<T> {
  const [sub, setSub] = useState<ActorSubscription<T>>({ state: null, connected: false, error: null });

  useEffect(() => {
    setSub({ state: null, connected: false, error: null });
    if (!id) return;
    let disposed = false;
    let socket: SocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let current: Record<string, unknown> | null = null;

    const schedule = () => {
      if (disposed || timer) return;
      const delay = Math.min(5000, 400 * 2 ** attempt);
      attempt++;
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      try {
        const grant = await getGrant(actor, id);
        if (disposed) return;
        const ws = openSocket(grant.websocketUrl);
        socket = ws;
        ws.onmessage = (ev) => {
          let msg: ActorMessage;
          try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ActorMessage;
          } catch {
            return;
          }
          if (msg.type === "state") {
            const m = msg as Extract<ActorMessage, { type: "state" }>;
            current = { ...(m.state ?? {}) };
            attempt = 0;
          } else if (msg.type === "state_update") {
            const m = msg as Extract<ActorMessage, { type: "state_update" }>;
            const next: Record<string, unknown> = { ...(current ?? {}), ...(m.changes ?? {}) };
            for (const k of m.removed ?? []) delete next[k];
            current = next;
          } else {
            return; // custom messages (e.g. "status") are ignored; state carries everything we draw
          }
          const snapshot = current as unknown as T;
          setSub({ state: snapshot, connected: true, error: null });
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          setSub((s) => ({ ...s, connected: false }));
          schedule();
        };
        ws.onerror = () => {
          /* onclose follows */
        };
      } catch (e) {
        if (disposed) return;
        setSub((s) => ({ ...s, connected: false, error: e instanceof Error ? e.message : String(e) }));
        schedule();
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, [actor, id]);

  return sub;
}
