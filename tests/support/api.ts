// Real PocketBase clients for view tests, plus test controls layered on top with vi.spyOn.
// There is no fake backend: every call reaches the throwaway server started by global-setup.ts.

import PocketBase, { BaseAuthStore } from "pocketbase";
import { inject, vi } from "vitest";
import { createApi, type Api } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import { toPb } from "../../web/src/lib/time.ts";
import type { Message, User } from "../../web/src/lib/types.ts";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const { join } = process.getBuiltinModule("node:path") as typeof import("node:path");

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A logged-out real client with its own in-memory auth store. */
export function newApi(): Api {
  return createApi(new PocketBase(inject("pbUrl"), new BaseAuthStore()));
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
  const user = await api.signUp({ email, password, name });
  return { api, user, email, password };
}

/**
 * Insert `n` messages straight into the test DB in one transaction: oldest first, `stepMs` apart, ending
 * in the past so later live messages sort after them. Fixture data only: no hooks, no realtime events.
 */
export async function seedMessages(
  room: string,
  author: string,
  n: number,
  opts: { text?: (i: number) => string; stepMs?: number } = {},
): Promise<Message[]> {
  const { text = (i) => `msg ${i + 1}`, stepMs = 1000 } = opts;
  const db = new DatabaseSync(join(inject("pbDataDir"), "data.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const name = (db.prepare("SELECT name FROM users WHERE id = ?").get(author) as { name: string }).name;
    const insert = db.prepare(
      "INSERT INTO messages (id, room, author, text, edited_at, deleted, deleted_at, created, updated) VALUES (?, ?, ?, ?, '', 0, '', ?, ?)",
    );
    const start = Date.now() - (n + 1) * stepMs;
    const out: Message[] = [];
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < n; i++) {
      const ts = toPb(start + i * stepMs);
      const m: Message = { id: newId(), room, author, text: text(i), created: ts, updated: ts, edited_at: "", deleted: false, expand: { author: { id: author, name } } };
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
  /** Pause every call to `op` until the returned function is called. */
  hold(op: AsyncOp): () => void;
  /** Call every live onConnect handler with reconnect=true, as after a dropped SSE connection. */
  reconnect(): void;
}

const SYNC = new Set<keyof Api>(["currentUser", "logOut", "onConnect"]);

/** Wrap a real client's methods (in place) with counting, failure injection, holds and reconnects. */
export function instrument(api: Api): Controls {
  const counts = new Map<string, number>();
  const failures = new Map<string, Error[]>();
  const holds = new Map<string, Promise<void>>();
  const connectFns = new Set<(reconnect: boolean) => void>();

  for (const op of Object.keys(api) as (keyof Api)[]) {
    if (SYNC.has(op)) continue;
    const original = (api[op] as (...a: unknown[]) => Promise<unknown>).bind(api);
    vi.spyOn(api, op as AsyncOp).mockImplementation((async (...args: unknown[]) => {
      counts.set(op, (counts.get(op) ?? 0) + 1);
      const held = holds.get(op);
      if (held) await held;
      const queued = failures.get(op);
      if (queued?.length) throw queued.shift();
      return original(...args);
    }) as never);
  }

  const onConnect = api.onConnect.bind(api);
  vi.spyOn(api, "onConnect").mockImplementation((fn) => {
    connectFns.add(fn);
    const off = onConnect(fn);
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
    reconnect: () => connectFns.forEach((fn) => fn(true)),
  };
}
