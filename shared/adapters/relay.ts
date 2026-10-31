/**
 * Agent Relay adapter (hosted Relaycast REST API over plain fetch).
 *
 * Why not @agent-relay/sdk: it is broker-bound (local broker binary, no Windows build).
 * This module talks to the hosted Relaycast engine directly. Every other package uses
 * only the exports below, so if the API shape changes only this file changes.
 *
 * Live-verified facts (Oct 31 2026):
 * - Base URL: https://armadillo.agentrelay.com/v1 (fast, ar_* credentials). The spec's
 *   https://cast.agentrelay.com/v1 works too but was slow (1.5-7 s writes) and returned
 *   503 database_overloaded. Override with RELAY_BASE_URL.
 * - Workspace names are NOT unique: every anonymous POST /workspaces makes a new one,
 *   so .relay-identities.json is the source of truth and bootstrap runs under a lock file.
 * - Agent tokens are returned once (POST /agents). A lost token is recovered with the
 *   workspace-owner takeover endpoint (POST /agents/{name}/takeover).
 * - Receiving: GET /workspace/events (workspace key) carries `message.created` (channel
 *   name, sender, text, metadata) and `dm.received` (conversation id, sender, text, but NO
 *   metadata and NO recipient). DMs are enriched with GET /messages/{id} (metadata) and
 *   GET /dm/conversations/all (participants, cached per conversation).
 * - The server adds `injection_mode` to message metadata; we strip it.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Channel = "radar" | "coord" | "alerts" | "cic";
export const CHANNELS: Channel[] = ["radar", "coord", "alerts", "cic"];

const CHANNEL_TOPICS: Record<Channel, string> = {
  radar: "Machine events from RADAR: BOUNDARY, CA, NONCONF, SESSION",
  coord: "Sector-to-sector coordination: handoffs, APREQs, resolutions",
  alerts: "Conformance alerts and actions",
  cic: "Controller-in-Charge directions and escalations",
};

export interface RelayMessage {
  id: string;
  seq?: number;
  /** Sender agent name, e.g. "RADAR", "NORTH". */
  from: string;
  /** "#radar" for channel messages, or the recipient agent name for DMs. */
  to: string;
  kind: "channel" | "dm";
  text: string;
  /** Structured payload we sent (Relaycast stores it as message `metadata`). */
  data: Record<string, unknown> | null;
  threadId: string | null;
  /** Epoch ms. */
  ts: number;
}

type AgentType = "agent" | "human" | "system";

interface IdentityFile {
  baseUrl: string;
  workspaceId: string;
  workspaceName: string;
  workspaceKey: string;
  agents: Record<string, { token: string; id?: string }>;
}

const DEFAULT_BASE_URL = "https://armadillo.agentrelay.com/v1";
const DEFAULT_WORKSPACE_NAME = "second-sight-haunted-hacks";
const POLL_MS = 750;
const LOG = "[relay]";

const ROOT_DIR = fileURLToPath(new URL("../../", import.meta.url));
const IDENTITY_PATH = ROOT_DIR + ".relay-identities.json";
const LOCK_PATH = ROOT_DIR + ".relay-identities.lock";

// ---------------------------------------------------------------- HTTP

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response, fallbackMs: number): number {
  const ra = Number(res.headers.get("retry-after"));
  return Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : fallbackMs;
}

/**
 * One API call. Retries 429/502/503/504 (honouring Retry-After) and network errors.
 * Writes carry an Idempotency-Key so a retry never duplicates a message.
 */
async function api<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  opts: { attempts?: number; idempotent?: boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.idempotent) headers["idempotency-key"] = crypto.randomUUID();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(500 * 2 ** i, 5000));
      continue;
    }
    const json: any = await res.json().catch(() => null);
    if (res.ok && json?.ok !== false) return json?.data as T;
    const code = json?.error?.code ?? "http_error";
    const msg = json?.error?.message ?? res.statusText;
    if ([429, 502, 503, 504].includes(res.status) && i < attempts - 1) {
      lastErr = new RelayHttpError(res.status, code, msg);
      await sleep(retryAfterMs(res, Math.min(500 * 2 ** i, 5000)));
      continue;
    }
    throw new RelayHttpError(res.status, code, msg);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------- identity file + lock

function readIdentityFile(): IdentityFile | null {
  try {
    if (!existsSync(IDENTITY_PATH)) return null;
    const parsed = JSON.parse(readFileSync(IDENTITY_PATH, "utf8"));
    if (!parsed?.workspaceKey) return null;
    parsed.agents ??= {};
    return parsed as IdentityFile;
  } catch {
    return null;
  }
}

function writeIdentityFile(f: IdentityFile): void {
  const tmp = `${IDENTITY_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2));
  renameSync(tmp, IDENTITY_PATH);
}

/** Cross-process mutex on a lock file. Stale locks (> 30 s) are broken. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      closeSync(openSync(LOCK_PATH, "wx"));
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > 30_000) unlinkSync(LOCK_PATH);
      } catch {
        /* lock vanished between calls */
      }
      if (Date.now() > deadline) throw new Error(`${LOG} timed out waiting for ${LOCK_PATH}`);
      await sleep(100 + Math.random() * 150);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  }
}

function configuredBaseUrl(): string {
  return (process.env.RELAY_BASE_URL || "").replace(/\/+$/, "");
}

/** Load or create the workspace. Must run under the lock. */
async function ensureWorkspace(): Promise<IdentityFile> {
  const envBase = configuredBaseUrl();
  const envKey = process.env.RELAY_WORKSPACE_KEY || "";
  let file = readIdentityFile();

  if (file && envBase && file.baseUrl !== envBase && !envKey) {
    const bak = ROOT_DIR + `.relay-identities.${Date.now()}.bak.json`;
    console.warn(`${LOG} RELAY_BASE_URL changed (${file.baseUrl} -> ${envBase}); moving old identities to ${bak}`);
    renameSync(IDENTITY_PATH, bak);
    file = null;
  }
  const baseUrl = envBase || file?.baseUrl || DEFAULT_BASE_URL;

  if (envKey) {
    if (file && file.workspaceKey === envKey) return file;
    const ws = await api<any>(baseUrl, "GET", "/workspace", envKey);
    const next: IdentityFile = {
      baseUrl,
      workspaceId: String(ws.id),
      workspaceName: String(ws.name),
      workspaceKey: envKey,
      agents: file && file.workspaceId === String(ws.id) ? file.agents : {},
    };
    writeIdentityFile(next);
    return next;
  }

  if (file) return file;

  const name = process.env.RELAY_WORKSPACE_NAME || DEFAULT_WORKSPACE_NAME;
  const created = await api<any>(baseUrl, "POST", "/workspaces", null, { name }, { attempts: 2 });
  const next: IdentityFile = {
    baseUrl,
    workspaceId: String(created.workspace_id),
    workspaceName: name,
    workspaceKey: String(created.api_key),
    agents: {},
  };
  writeIdentityFile(next);
  console.log(`${LOG} created workspace ${name} (${next.workspaceId}); identities saved to .relay-identities.json`);
  return next;
}

/** Register the agent, or take it over if it exists but its token is lost. Must run under the lock. */
async function ensureAgent(
  file: IdentityFile,
  name: string,
  type: AgentType,
  persona: string | undefined,
  forceRecover = false,
): Promise<IdentityFile> {
  const existing = file.agents[name];
  if (existing?.token && !forceRecover) return file;
  let token: string;
  let id: string | undefined;
  try {
    if (forceRecover) throw new RelayHttpError(409, "agent_already_exists", "forced recovery");
    const a = await api<any>(file.baseUrl, "POST", "/agents", file.workspaceKey, {
      name,
      type,
      ...(persona ? { persona } : {}),
    });
    token = a.token;
    id = a.id;
  } catch (err) {
    if (!(err instanceof RelayHttpError) || err.status !== 409) throw err;
    // Name exists but we have no usable token: workspace-owner takeover issues a new one.
    const agent = await api<any>(file.baseUrl, "GET", `/agents/${encodeURIComponent(name)}`, file.workspaceKey);
    const rec = await api<any>(file.baseUrl, "POST", `/agents/${encodeURIComponent(name)}/takeover`, file.workspaceKey, {
      expected_agent_id: agent.id,
      actor: "second-sight-bootstrap",
      reason: "agent token missing from .relay-identities.json",
      session_ref: crypto.randomUUID(),
      node_id: agent.origin_node_id ?? `node_direct_${agent.id}`,
    });
    token = rec.token;
    id = rec.agent_id ?? agent.id;
    console.warn(`${LOG} recovered identity ${name} via takeover`);
  }
  const fresh = readIdentityFile() ?? file;
  fresh.agents = { ...fresh.agents, [name]: { token, id } };
  writeIdentityFile(fresh);
  return fresh;
}

let lastFile: IdentityFile | null = null;

/** Workspace info for logs / UI. Never includes credentials. */
export function workspaceInfo(): { workspaceId: string; name: string; observerHint?: string } {
  const f = lastFile ?? readIdentityFile();
  if (!f) return { workspaceId: "", name: "", observerHint: "Relay not bootstrapped yet (no .relay-identities.json)." };
  return {
    workspaceId: f.workspaceId,
    name: f.workspaceName,
    // Verified Oct 31: the hosted Observer only accepts cast.agentrelay.com credentials (rk_live_/ot_live_);
    // it rejects armadillo workspace keys and observer tokens server-side. Use the in-app Relay feed instead.
    observerHint: f.baseUrl.includes("cast.agentrelay.com")
      ? "Open https://agentrelay.com/observer?key=<ot_live_ observer token from createObserverToken()> (auto-login)."
      : "The hosted Observer only supports cast.agentrelay.com workspaces; this workspace is on " +
        f.baseUrl +
        ". Show coordination in the app's Relay feed (Airspace.feed).",
  };
}

/**
 * Create a read-only observer token (ot_live_... or ar_ob_...) for the Agent Relay Observer, so the
 * workspace key never has to be pasted on a projector. Returned once; not persisted.
 */
export async function createObserverToken(label = `observer-${Date.now()}`): Promise<string> {
  const f = await withLock(ensureWorkspace);
  lastFile = f;
  const t = await api<any>(f.baseUrl, "POST", "/observer-tokens", f.workspaceKey, {
    name: label,
    scopes: ["stream:read", "messages:read", "threads:read", "dms:read", "channels:read", "agents:read"],
    filters: { include_dms: true },
  });
  return String(t.token);
}

// ---------------------------------------------------------------- message mapping

function cleanData(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const { injection_mode: _ignored, ...rest } = meta as Record<string, unknown>;
  return Object.keys(rest).length ? rest : null;
}

function toTs(createdAt: unknown): number {
  const t = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

type Subscriber = {
  scope: "mine" | "all";
  handler: (m: RelayMessage) => void | Promise<void>;
  /** Only deliver events with seq > minSeq; null until the cursor is known. */
  minSeq: number | null;
};

// ---------------------------------------------------------------- Relay

export class Relay {
  readonly name: string;
  private file: IdentityFile;
  private readonly type: AgentType;
  private readonly persona: string | undefined;

  private subs = new Set<Subscriber>();
  private cursor: number | null = null;
  private polling = false;
  private closed = false;
  private seenIds = new Set<string>();
  private convParticipants = new Map<string, string[]>();

  private constructor(name: string, file: IdentityFile, type: AgentType, persona: string | undefined) {
    this.name = name;
    this.file = file;
    this.type = type;
    this.persona = persona;
  }

  static async connect(name: string, opts: { persona?: string; type?: AgentType } = {}): Promise<Relay> {
    const type = opts.type ?? "agent";
    const file = await withLock(async () => ensureAgent(await ensureWorkspace(), name, type, opts.persona));
    lastFile = file;
    const relay = new Relay(name, file, type, opts.persona);
    await relay.ensureChannels();
    return relay;
  }

  private get token(): string {
    return this.file.agents[this.name]!.token;
  }

  /** Agent-token call; on a dead token, recover the identity once and retry. */
  private async agentApi<T = any>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
    try {
      return await api<T>(this.file.baseUrl, method, path, this.token, body, { idempotent });
    } catch (err) {
      if (!(err instanceof RelayHttpError) || err.status !== 401 || err.code === "workspace_expired") throw err;
      const stale = this.token;
      this.file = await withLock(async () => {
        const f = (await ensureWorkspace()) as IdentityFile;
        const cur = f.agents[this.name]?.token;
        // Another process may already have recovered it.
        return cur && cur !== stale ? f : ensureAgent(f, this.name, this.type, this.persona, true);
      });
      lastFile = this.file;
      return api<T>(this.file.baseUrl, method, path, this.token, body, { idempotent });
    }
  }

  private async ensureChannels(): Promise<void> {
    const { baseUrl, workspaceKey } = this.file;
    let existing = new Set<string>();
    try {
      const list = await api<any[]>(baseUrl, "GET", "/channels", workspaceKey);
      existing = new Set(list.map((c) => c.name));
    } catch (err) {
      console.warn(`${LOG} could not list channels: ${(err as Error).message}`);
    }
    await Promise.all(
      CHANNELS.map(async (ch) => {
        if (!existing.has(ch)) {
          try {
            await api(baseUrl, "POST", "/channels", workspaceKey, { name: ch, topic: CHANNEL_TOPICS[ch] });
          } catch (err) {
            if (!(err instanceof RelayHttpError) || err.status !== 409) throw err;
          }
        }
        await this.agentApi("POST", `/channels/${ch}/join`);
      }),
    );
  }

  async post(channel: Channel, text: string, data?: Record<string, unknown>): Promise<RelayMessage> {
    const m = await this.agentApi<any>("POST", `/channels/${channel}/messages`, { text, ...(data ? { data } : {}) }, true);
    return {
      id: String(m.id),
      from: m.agent_name ?? this.name,
      to: `#${channel}`,
      kind: "channel",
      text: m.text ?? text,
      data: cleanData(m.metadata) ?? (data ?? null),
      threadId: m.thread_id ?? null,
      ts: toTs(m.created_at),
    };
  }

  async dm(to: string, text: string, data?: Record<string, unknown>): Promise<RelayMessage> {
    const r = await this.agentApi<any>("POST", "/dm", { to, text, ...(data ? { data } : {}) }, true);
    const msg = r.message ?? r;
    if (r.conversation_id && !this.convParticipants.has(r.conversation_id)) {
      this.convParticipants.set(r.conversation_id, [this.name, to]);
    }
    return {
      id: String(msg.id ?? r.id),
      from: msg.agent_name ?? this.name,
      to,
      kind: "dm",
      text: msg.text ?? text,
      data: cleanData(msg.metadata ?? r.metadata) ?? (data ?? null),
      threadId: null,
      ts: toTs(r.created_at),
    };
  }

  onMessage(handler: (m: RelayMessage) => void | Promise<void>): () => void {
    return this.subscribe("mine", handler);
  }

  watchAll(handler: (m: RelayMessage) => void | Promise<void>): () => void {
    return this.subscribe("all", handler);
  }

  waitFor(pred: (m: RelayMessage) => boolean, timeoutMs: number): Promise<RelayMessage | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (m: RelayMessage | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(m);
      };
      const unsub = this.onMessage((m) => {
        try {
          if (pred(m)) finish(m);
        } catch {
          /* predicate errors never match */
        }
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
  }

  // -------------------------------------------------------------- receive loop

  private subscribe(scope: Subscriber["scope"], handler: Subscriber["handler"]): () => void {
    const sub: Subscriber = { scope, handler, minSeq: this.cursor };
    this.subs.add(sub);
    if (!this.polling && !this.closed) void this.pollLoop();
    return () => {
      this.subs.delete(sub);
    };
  }

  private async pollLoop(): Promise<void> {
    this.polling = true;
    let backoff = 0;
    try {
      while (!this.closed && this.subs.size > 0) {
        try {
          if (this.cursor === null) {
            const head = await api<any>(this.file.baseUrl, "GET", "/workspace/events?since=0&limit=1", this.file.workspaceKey);
            this.cursor = Number(head.latest_seq ?? 0);
            for (const s of this.subs) if (s.minSeq === null) s.minSeq = this.cursor;
          }
          let more = true;
          while (more && !this.closed) {
            const page: any = await api<any>(
              this.file.baseUrl,
              "GET",
              `/workspace/events?since=${this.cursor}&limit=200`,
              this.file.workspaceKey,
              undefined,
              { attempts: 1 },
            );
            const events: any[] = page.events ?? [];
            for (const ev of events) {
              await this.handleEvent(ev);
              // Advance per event so a subscriber added inside a handler starts after it.
              if (Number(ev.seq) > (this.cursor ?? 0)) this.cursor = Number(ev.seq);
            }
            const next: number = Number(page.next_since ?? events.at(-1)?.seq ?? this.cursor);
            if (next > (this.cursor ?? 0)) this.cursor = next;
            more = events.length >= 200;
          }
          backoff = 0;
          await sleep(POLL_MS);
        } catch (err) {
          backoff = Math.min(backoff ? backoff * 2 : 1000, 10_000);
          const wait =
            err instanceof RelayHttpError && (err.status === 429 || err.status === 503) ? Math.max(backoff, 2000) : backoff;
          console.warn(`${LOG} ${this.name} poll error (${(err as Error).message}); retrying in ${wait} ms`);
          await sleep(wait);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async handleEvent(ev: any): Promise<void> {
    const seq = Number(ev.seq);
    const p = ev.payload ?? {};
    let msg: RelayMessage | null = null;

    if ((ev.type === "message.created" || ev.type === "thread.reply") && p.message && p.channel) {
      const m = p.message;
      const channel = typeof p.channel === "string" ? p.channel : p.channel?.name;
      if (!channel) return;
      msg = {
        id: String(m.id),
        seq,
        from: String(m.agent_name ?? ""),
        to: `#${channel}`,
        kind: "channel",
        text: String(m.text ?? ""),
        data: cleanData(m.metadata),
        threadId: m.thread_id ?? p.thread_id ?? null,
        ts: toTs(m.created_at ?? p.created_at),
      };
    } else if (ev.type === "dm.received" && p.message && p.conversation_id) {
      msg = await this.buildDm(seq, p);
    }
    if (!msg || this.seenIds.has(msg.id)) return;
    this.seenIds.add(msg.id);
    if (this.seenIds.size > 2000) this.seenIds = new Set([...this.seenIds].slice(-1000));

    for (const sub of [...this.subs]) {
      if (sub.minSeq === null || seq <= sub.minSeq) continue;
      if (sub.scope === "mine") {
        if (msg.from === this.name) continue;
        if (msg.kind === "channel" && !CHANNELS.includes(msg.to.slice(1) as Channel)) continue;
        if (msg.kind === "dm" && msg.to !== this.name) continue;
      }
      try {
        await sub.handler(msg);
      } catch (err) {
        console.error(`${LOG} ${this.name} handler error:`, err);
      }
    }
  }

  /** dm.received lacks recipient and metadata: resolve both (cached participants, per-message metadata). */
  private async buildDm(seq: number, p: any): Promise<RelayMessage | null> {
    const m = p.message;
    const from = String(m.agent_name ?? "");
    const convId = String(p.conversation_id);
    let participants = this.convParticipants.get(convId);
    if (!participants) {
      try {
        const all = await api<any[]>(this.file.baseUrl, "GET", "/dm/conversations/all", this.file.workspaceKey);
        for (const c of all ?? []) {
          const names = (c.participants ?? []).map((x: any) => (typeof x === "string" ? x : x?.agent_name)).filter(Boolean);
          this.convParticipants.set(String(c.id), names);
        }
      } catch (err) {
        console.warn(`${LOG} could not list DM conversations: ${(err as Error).message}`);
      }
      participants = this.convParticipants.get(convId) ?? [];
    }
    const to = participants.find((n) => n !== from) ?? (participants.length ? from : "");

    // Only fetch metadata if some subscriber will receive this DM.
    const wanted = [...this.subs].some(
      (s) => s.minSeq !== null && seq > s.minSeq && (s.scope === "all" || (to === this.name && from !== this.name)),
    );
    if (!wanted) return null;

    let data: Record<string, unknown> | null = cleanData(m.metadata);
    let ts = toTs(m.created_at ?? p.created_at);
    if (!data) {
      try {
        const full = await api<any>(this.file.baseUrl, "GET", `/messages/${m.id}`, this.file.workspaceKey);
        data = cleanData(full?.metadata);
        ts = toTs(full?.created_at ?? p.created_at);
      } catch (err) {
        console.warn(`${LOG} could not fetch DM ${m.id} metadata: ${(err as Error).message}`);
      }
    }
    return { id: String(m.id), seq, from, to, kind: "dm", text: String(m.text ?? ""), data, threadId: null, ts };
  }
}
