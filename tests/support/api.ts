// Real PocketBase clients for view tests, plus test controls layered on top of them.
// There is no fake backend: every call reaches the throwaway server started by global-setup.ts.

import { inject, vi } from "vitest";
import { createRoomActions } from "../../web/src/actions.ts";
import { type Api, createApi } from "../../web/src/api.ts";
import type { Ctx } from "../../web/src/context.ts";
import { createDrafts } from "../../web/src/drafts.ts";
import { newId } from "../../web/src/lib/id.ts";
import { toPb } from "../../web/src/lib/time.ts";
import type { Message, User } from "../../web/src/lib/types.ts";
import { createClient } from "../../web/src/pb.ts";
import type { AppState, Store } from "../../web/src/store.ts";
import { createSync } from "../../web/src/sync.ts";
import { createUnread, type UnreadTiming } from "../../web/src/unread.ts";
import { uniq } from "./ids.ts";
import { withName } from "./names.ts";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const { join } = process.getBuiltinModule("node:path") as typeof import("node:path");

export { uniq } from "./ids.ts";

const clients = new Set<Api>();

/** Realtime subscriptions each client has asked for, as promises that settle once the server has them. */
const subscriptions = new WeakMap<Api, Promise<unknown>[]>();
const SUBSCRIBE_OPS = ["subscribeMessages", "subscribeRooms", "subscribeHidden", "subscribeAllMessages", "subscribeReads"] as const;

/** A logged-out real client with its own in-memory auth store. */
export function newApi(): Api {
  const api = createApi(createClient(inject("pbUrl")));
  const pending: Promise<unknown>[] = [];
  subscriptions.set(api, pending);
  // A plain wrapper, not intercept(): that installs a vi.fn, which a later vi.spyOn would reuse (and call itself).
  for (const op of SUBSCRIBE_OPS) {
    const original = (api[op] as (...a: never[]) => Promise<unknown>).bind(api);
    (api as unknown as Record<string, unknown>)[op] = (...args: never[]) => {
      const p = original(...args);
      pending.push(p.catch(() => {}));
      return p;
    };
  }
  clients.add(api);
  return api;
}

/**
 * Resolves once every realtime subscription `api` has asked for so far (by the services, the views, or the test) is
 * registered on the server: an event caused after this reaches it. The client's subscribe() resolves only then.
 * Replaces "sleep to let the subscriptions settle".
 */
export async function subscribed(api: Api): Promise<void> {
  const pending = subscriptions.get(api) ?? [];
  for (let seen = -1; seen !== pending.length; ) {
    seen = pending.length;
    await Promise.all(pending);
  }
}

/** Close every client's realtime connection (run after each test, before happy-dom tears the window down). */
export async function closeClients(): Promise<void> {
  await Promise.all([...clients].map((c) => c.unsubscribeAll().catch(() => {})));
  clients.clear();
}

export interface SignedUp {
  api: Api;
  user: User;
  email: string;
  password: string;
}

/** A fresh user, signed up and logged in on its own client. */
export async function signedUp(name = `user-${uniq()}`): Promise<SignedUp> {
  const api = newApi();
  const email = `${uniq()}@test.local`;
  const password = "password-123";
  const db = () => new DatabaseSync(join(inject("pbDataDir"), "data.db"));
  const user = await withName(db, name, () => api.signUp({ email, password, name }));
  return { api, user, email, password };
}

/**
 * Insert `n` messages straight into the test DB in one transaction: oldest first, `stepMs` apart, starting at
 * `startAt` (default: so the last one is `stepMs` in the past, before any live message). Fixture data only: no
 * hooks, no realtime events.
 */
export async function seedMessages(
  room: string,
  author: string,
  n: number,
  opts: { text?: (i: number) => string; stepMs?: number; startAt?: number } = {},
): Promise<Message[]> {
  const { text = (i) => `msg ${i + 1}`, stepMs = 1000, startAt } = opts;
  const db = new DatabaseSync(join(inject("pbDataDir"), "data.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const name = (db.prepare("SELECT name FROM users WHERE id = ?").get(author) as { name: string }).name;
    const insert = db.prepare(
      "INSERT INTO messages (id, room, author, text, edited_at, deleted, deleted_at, created, updated) VALUES (?, ?, ?, ?, '', 0, '', ?, ?)",
    );
    const start = startAt ?? Date.now() - (n + 1) * stepMs;
    const out: Message[] = [];
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < n; i++) {
      const ts = toPb(start + i * stepMs);
      const m: Message = {
        id: newId(),
        room,
        author,
        text: text(i),
        created: ts,
        updated: ts,
        edited_at: "",
        deleted: false,
        expand: { author: { id: author, name } },
      };
      insert.run(m.id, room, author, m.text, ts, ts);
      out.push(m);
    }
    db.exec("COMMIT");
    return out;
  } finally {
    db.close();
  }
}

type AsyncOp = { [K in keyof Api]: Api[K] extends (...a: never[]) => Promise<unknown> ? K : never }[keyof Api];

export interface Controls {
  /** How many times `op` has been called. */
  calls(op: AsyncOp): number;
  /** Make the next call to `op` reject with `err` (queue several by calling repeatedly). */
  failNext(op: AsyncOp, err: Error): void;
  /** Delay every response of `op` until the returned function is called. The request itself goes out
   * immediately, as with real network latency: the server sees it before anything that happens meanwhile. */
  hold(op: AsyncOp): () => void;
  /** Call every live onConnect handler with reconnect=true, as after a dropped SSE connection. */
  reconnect(): void;
}

const SYNC = new Set<keyof Api>([
  "currentUser",
  "sessionExpiry",
  "logOut",
  "onAuthChange",
  "onRejected",
  "onConnect",
  "avatarUrl",
  "fileUrl",
]);

/**
 * Replace `api[op]` with a vi.fn built from the current implementation. Composes by reassignment, so
 * interceptors stack correctly in any order (stacking vi.spyOn on one method makes it call itself).
 */
export function intercept<K extends keyof Api>(api: Api, op: K, make: (original: Api[K]) => Api[K]): void {
  const original = (api[op] as (...a: unknown[]) => unknown).bind(api) as Api[K];
  api[op] = vi.fn(make(original) as (...a: unknown[]) => unknown) as unknown as Api[K];
}

/** Wrap a real client's methods (in place) with counting, failure injection, holds and reconnects. */
export function instrument(api: Api): Controls {
  const counts = new Map<string, number>();
  const failures = new Map<string, Error[]>();
  const holds = new Map<string, Promise<void>>();
  const connectFns = new Set<(reconnect: boolean) => void>();

  for (const op of Object.keys(api) as (keyof Api)[]) {
    if (SYNC.has(op)) continue;
    intercept(
      api,
      op as AsyncOp,
      (original) =>
        (async (...args: never[]) => {
          counts.set(op, (counts.get(op) ?? 0) + 1);
          const held = holds.get(op);
          const queued = failures.get(op);
          const failure = queued?.length ? queued.shift() : undefined;
          const result = failure ? Promise.reject(failure) : (original as (...a: never[]) => Promise<unknown>)(...args);
          result.catch(() => {}); // observed below; avoid an unhandled rejection while held
          if (held) await held;
          return result;
        }) as never,
    );
  }

  intercept(api, "onConnect", (original) => (fn) => {
    connectFns.add(fn);
    const off = original(fn);
    return () => {
      connectFns.delete(fn);
      off();
    };
  });

  return {
    calls: (op) => counts.get(op) ?? 0,
    failNext: (op, err) => failures.set(op, [...(failures.get(op) ?? []), err]),
    hold(op) {
      let release!: () => void;
      holds.set(op, new Promise<void>((r) => (release = r)));
      return () => {
        holds.delete(op);
        release();
      };
    },
    reconnect() {
      for (const fn of connectFns) fn(true);
    },
  };
}

/**
 * What the app shell hands a view, around a real client, with the room sync and the unread counts already running
 * (as they are whenever someone is logged in). Build it after `instrument()`/`intercept()` so they see those.
 */
/** Unread timing for tests: the app's, shortened (reads batch for 100 ms, not 1 s). */
export const TEST_TIMING: UnreadTiming = { refreshMs: 50, readMs: 100 };
/** Long enough that a read batched with TEST_TIMING would have been sent: to check that none was. */
export const READ_WINDOW_MS = 300;

export function viewContext(api: Api, store: Store<AppState>, navigate: (hash: string) => void): Ctx {
  const sync = createSync({ api, store });
  const unread = createUnread({ api, store, timing: TEST_TIMING });
  sync.start();
  unread.start();
  contexts.add(sync);
  contexts.add(unread);
  const drafts = createDrafts(() => store.get().user?.id ?? "");
  return { api, store, sync, unread, actions: createRoomActions({ api, store }), navigate, drafts, logOut: vi.fn() };
}

const contexts = new Set<{ stop(): void }>();

/** Stop every sync and unread service started by viewContext (run after each test). */
export function stopContexts(): void {
  for (const s of contexts) s.stop();
  contexts.clear();
}
