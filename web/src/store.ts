// Tiny observable app state (§7.4). Message lists are owned by the room view, not stored here.

import type { Room, User } from "./lib/types.ts";

type Listener<S> = (state: S, prev: S) => void;

export interface Store<S extends object> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      if (!(Object.keys(p) as (keyof S)[]).some((k) => p[k] !== state[k])) return;
      const prev = state;
      state = { ...state, ...p };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Where the room list is in its load cycle (owned by sync.ts). "error" keeps whatever was loaded before. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface AppState {
  user: User | null;
  rooms: Map<string, Room>;
  /** roomId → hidden_rooms row id (needed to unhide). */
  hidden: Map<string, string>;
  roomsStatus: LoadStatus;
  activeRoomId: string | null;
}

export const initialState = (): AppState => ({
  user: null,
  rooms: new Map(),
  hidden: new Map(),
  roomsStatus: "idle",
  activeRoomId: null,
});

// ---- updates: pass to store.set(). Maps are replaced, never mutated, so listeners can compare by identity.

type Update = (s: AppState) => Partial<AppState>;

export function upsertRoom(r: Room): Update {
  return (s) => ({ rooms: new Map(s.rooms).set(r.id, r) });
}

export function removeRoom(roomId: string): Update {
  return (s) => {
    const rooms = new Map(s.rooms);
    rooms.delete(roomId);
    return { rooms };
  };
}

export function markHidden(roomId: string, rowId: string): Update {
  return (s) => ({ hidden: new Map(s.hidden).set(roomId, rowId) });
}

/** Forget a hidden_rooms row (realtime deletes only carry the row id, not the room). */
export function unmarkHidden(rowId: string): Update {
  return (s) => ({ hidden: new Map([...s.hidden].filter(([, row]) => row !== rowId)) });
}

// ---- selectors

const byName = (a: Room, b: Room) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** Room list sections (§7.1). Archived wins over hidden. */
export function roomSections(s: AppState): { rooms: Room[]; hidden: Room[]; archived: Room[] } {
  const rooms: Room[] = [];
  const hidden: Room[] = [];
  const archived: Room[] = [];
  for (const r of s.rooms.values()) {
    if (r.archived) archived.push(r);
    else if (s.hidden.has(r.id)) hidden.push(r);
    else rooms.push(r);
  }
  return { rooms: rooms.sort(byName), hidden: hidden.sort(byName), archived: archived.sort(byName) };
}
