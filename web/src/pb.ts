// A minimal PocketBase client: only what api.ts uses (REST requests, the auth store, realtime over SSE, file URLs).
// It replaces the official JS SDK, whose admin services, OAuth2/OTP/MFA flows and cookie helpers the app never used
// but always shipped (§7.7). The wire behavior follows SDK 0.28: same storage key, query and realtime protocol.

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query | undefined;
  /** JSON, or multipart when any value is a Blob/File (or an array of them). */
  body?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
}

export interface AuthRecord {
  id: string;
  collectionName?: string;
  [field: string]: unknown;
}

/** A failed request: `status` 0 for network trouble or an abort. `response` is PocketBase's error body. */
export class PbError extends Error {
  readonly status: number;
  readonly response: { message?: string; data?: Record<string, { message?: unknown; code?: unknown }> };
  readonly isAbort: boolean;

  constructor(status: number, response: PbError["response"] = {}, isAbort = false) {
    super(response.message || "Something went wrong.");
    this.name = "PbError";
    this.status = status;
    this.response = response;
    this.isAbort = isAbort;
  }
}

// ---- auth store ----

export interface AuthStore {
  readonly token: string;
  readonly record: AuthRecord | null;
  /** There is a token and it hasn't expired. */
  readonly isValid: boolean;
  /** When the token expires (epoch ms), or 0 without a (readable) token. */
  readonly expiresAt: number;
  save(token: string, record: AuthRecord | null): void;
  clear(): void;
  /** Called on every save/clear, including another tab's when the store is backed by localStorage. */
  onChange(fn: () => void): () => void;
}

/** The SDK's key, so existing sessions survive the switch. */
const STORAGE_KEY = "pocketbase_auth";

/** The JWT's `exp` (seconds), or 0 when it can't be read. */
function tokenExp(token: string): number {
  try {
    const part = token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
    return Number(JSON.parse(atob(part)).exp) || 0;
  } catch {
    return 0;
  }
}

/** In memory only, or persisted in `storage` (shared with the other tabs of this browser). */
export function createAuthStore(storage?: Storage): AuthStore {
  let token = "";
  let record: AuthRecord | null = null;
  const listeners = new Set<() => void>();

  const load = (raw: string | null) => {
    let data: { token?: string; record?: AuthRecord | null } = {};
    try {
      data = JSON.parse(raw || "{}") ?? {};
    } catch {}
    token = data.token || "";
    record = data.record || null;
  };
  const set = (t: string, r: AuthRecord | null) => {
    token = t;
    record = r;
    for (const fn of [...listeners]) fn();
  };

  if (storage) {
    load(storage.getItem(STORAGE_KEY));
    addEventListener("storage", (e) => {
      if (e.key !== STORAGE_KEY) return;
      load(e.newValue);
      set(token, record);
    });
  }

  return {
    get token() {
      return token;
    },
    get record() {
      return record;
    },
    get isValid() {
      return tokenExp(token) > Date.now() / 1000;
    },
    get expiresAt() {
      return tokenExp(token) * 1000;
    },
    save(t, r) {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ token: t, record: r }));
      set(t, r);
    },
    clear() {
      storage?.removeItem(STORAGE_KEY);
      set("", null);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

// ---- client ----

export type Unsubscribe = () => Promise<void>;

export interface Realtime {
  /** Connected, with a client id, and no connect in progress. */
  readonly isConnected: boolean;
  /**
   * Listen to `topic` (e.g. "messages/*", or "PB_CONNECT" for every (re)connect). Resolves once the server has the
   * subscription, so an event caused after that reaches `fn`. `query` (fields, expand, filter) applies to its events.
   */
  subscribe(topic: string, fn: (data: unknown) => void, query?: Query): Promise<Unsubscribe>;
  /** Drop every subscription and close the connection. */
  unsubscribe(): Promise<void>;
}

export interface PbClient {
  readonly authStore: AuthStore;
  readonly realtime: Realtime;
  send<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** Bind `{:name}` placeholders in a filter expression, quoting and escaping the values. */
  filter(expr: string, params: Record<string, string | number | boolean | null>): string;
  /** URL of a record's file (`query`: thumb, token). */
  fileUrl(collection: string, recordId: string, filename: string, query?: Query): string;
}

const qs = (query: Query = {}) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

const isFiles = (v: unknown) => v instanceof Blob || (Array.isArray(v) && v.some((x) => x instanceof Blob));

/** A body holding files as multipart: files and strings as fields, anything else in PocketBase's `@jsonPayload`. */
function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (isFiles(v)) for (const f of [v].flat() as Blob[]) form.append(k, f);
    else if (typeof v === "string") form.append(k, v);
    else form.append("@jsonPayload", JSON.stringify({ [k]: v }));
  }
  return form;
}

export function createClient(baseUrl: string, authStore: AuthStore = createAuthStore()): PbClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function send<T>(path: string, { method = "GET", query, body, signal }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (authStore.token) headers.Authorization = authStore.token;
    let payload: BodyInit | undefined;
    if (body) {
      if (Object.values(body).some(isFiles)) payload = toFormData(body);
      else {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    const aborted = (e: unknown) => !!signal?.aborted || (e as Error)?.name === "AbortError";
    let res: Response;
    let data: PbError["response"] = {};
    try {
      res = await fetch(base + path + qs(query), { method, headers, ...(payload ? { body: payload } : {}), ...(signal ? { signal } : {}) });
      data = await res.json().catch((e) => {
        if (aborted(e)) throw e;
        return {};
      });
    } catch (e) {
      throw new PbError(0, {}, aborted(e));
    }
    if (res.status >= 400) throw new PbError(res.status, data ?? {});
    return data as T;
  }

  const realtime = createRealtime(`${base}/api/realtime`, send);
  // The server reads who a realtime client is from the token its subscriptions were sent with. A new token (a password
  // change, which revokes the old ones, here or in another tab) must reach it, or nothing more arrives (QA BUG-52).
  let token = authStore.token;
  authStore.onChange(() => {
    if (authStore.token === token) return;
    token = authStore.token;
    realtime.resubmit();
  });

  return {
    authStore,
    realtime,
    send,
    filter: (expr, params) =>
      expr.replace(/\{:(\w+)\}/g, (match, name: string) => {
        if (!Object.hasOwn(params, name)) return match;
        const v = params[name];
        return typeof v === "string" ? JSON.stringify(v) : String(v);
      }),
    fileUrl: (collection, recordId, filename, query) =>
      `${base}/api/files/${[collection, recordId, filename].map(encodeURIComponent).join("/")}${qs(query)}`,
  };
}

// ---- realtime ----

/** Wait before reconnect attempt n (the last value repeats), as the SDK does. */
const RECONNECT_MS = [200, 300, 500, 1000, 1200, 1500, 2000];
const CONNECT_TIMEOUT_MS = 15_000;

type Listener = (e: Event) => void;

/**
 * The SDK's realtime protocol: one EventSource; PB_CONNECT carries the client id; the set of subscriptions (each a
 * topic plus its serialized options) is POSTed to /api/realtime whenever it changes, and again after a reconnect.
 */
function createRealtime(url: string, send: PbClient["send"]): Realtime & { resubmit(): void } {
  let es: EventSource | null = null;
  let clientId = "";
  /** Subscription key → listeners. A key is the topic plus its options, and the event name the server uses. */
  const subs = new Map<string, Listener[]>();
  let lastSent: string[] = [];
  let attempts = 0;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  /** The in-flight subscriptions POST, aborted on disconnect. */
  let submitting: AbortController | null = null;
  /** Submits run one after another, so an older subscription set never lands after a newer one. */
  let queue: Promise<unknown> = Promise.resolve();

  const keys = () => [...subs.keys()];
  const unsent = () => {
    const now = keys();
    return now.length !== lastSent.length || now.some((k) => !lastSent.includes(k));
  };
  const bindAll = (add: boolean) => {
    for (const [key, fns] of subs) for (const fn of fns) add ? es?.addEventListener(key, fn) : es?.removeEventListener(key, fn);
  };

  async function sendSubs(): Promise<void> {
    if (!clientId) return;
    if (!subs.size) return disconnect();
    if (!unsent()) return;
    bindAll(false);
    bindAll(true);
    lastSent = keys();
    submitting = new AbortController();
    try {
      await send("/api/realtime", { method: "POST", body: { clientId, subscriptions: lastSent }, signal: submitting.signal });
    } catch (e) {
      if (!(e instanceof PbError && e.isAbort)) throw e;
    }
  }

  function submit(): Promise<void> {
    const p = queue.then(sendSubs);
    queue = p.catch(() => {});
    return p;
  }

  function connect(): Promise<void> {
    if (attempts > 0) return Promise.resolve(); // a reconnect is scheduled; it sends every subscription
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (pending.length === 1) queueMicrotask(initConnect);
    });
  }

  function initConnect() {
    disconnect(true);
    connectTimer = setTimeout(() => connectError(new Error("EventSource connect took too long.")), CONNECT_TIMEOUT_MS);
    es = new EventSource(url);
    es.onerror = () => connectError(new Error("Failed to establish realtime connection."));
    es.addEventListener("PB_CONNECT", (e) => {
      clientId = (e as MessageEvent).lastEventId;
      lastSent = [];
      submit()
        .then(async () => {
          for (let tries = 3; unsent() && tries > 0; tries--) await submit();
          for (const p of pending) p.resolve();
          pending = [];
          attempts = 0;
          clearTimeout(reconnectTimer);
          clearTimeout(connectTimer);
          for (const fn of subs.get("PB_CONNECT") ?? []) fn(e);
          if (unsent()) await submit();
        })
        .catch((err) => {
          clientId = "";
          lastSent = [];
          connectError(err);
        });
    });
  }

  function connectError(err: unknown) {
    clearTimeout(connectTimer);
    clearTimeout(reconnectTimer);
    if (!clientId && !attempts) {
      // The first connect failed: report it rather than retrying forever.
      for (const p of pending) p.reject(err instanceof PbError ? err : new PbError(0));
      pending = [];
      disconnect();
      return;
    }
    disconnect(true);
    reconnectTimer = setTimeout(initConnect, RECONNECT_MS[Math.min(attempts, RECONNECT_MS.length - 1)]);
    attempts++;
  }

  function disconnect(reconnecting = false) {
    clearTimeout(connectTimer);
    clearTimeout(reconnectTimer);
    bindAll(false);
    submitting?.abort();
    submitting = null;
    es?.close();
    es = null;
    clientId = "";
    lastSent = [];
    if (!reconnecting) {
      attempts = 0;
      for (const p of pending) p.resolve();
      pending = [];
    }
  }

  return {
    get isConnected() {
      return !!es && !!clientId && !pending.length;
    },
    async subscribe(topic, fn, query) {
      const key = query ? `${topic}?options=${encodeURIComponent(JSON.stringify({ query }))}` : topic;
      const listener: Listener = (e) => {
        let data: unknown;
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {}
        fn(data || {});
      };
      const fns = subs.get(key) ?? [];
      subs.set(key, [...fns, listener]);
      if (!es || !clientId || pending.length) await connect();
      else if (!fns.length) await submit();
      else es.addEventListener(key, listener);

      return async () => {
        const left = (subs.get(key) ?? []).filter((f) => f !== listener);
        es?.removeEventListener(key, listener);
        if (left.length) subs.set(key, left);
        else subs.delete(key);
        await submit();
      };
    },
    async unsubscribe() {
      bindAll(false);
      subs.clear();
      await submit();
    },
    /** Send the subscriptions again (with the current token), if connected. */
    resubmit() {
      if (!clientId || !subs.size) return;
      lastSent = [];
      submit().catch(() => connectError(new PbError(0)));
    },
  };
}
