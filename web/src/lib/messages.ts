// The message list as a sliding window over a room's history (§7.5).
// Pure functions: every operation returns a new window (or the same object when nothing changed).

import { PAGE_SIZE } from "./cursor.ts";
import { parsePb } from "./time.ts";
import type { Message } from "./types.ts";

export const WINDOW_MAX = 300;
const GROUP_GAP_MS = 5 * 60 * 1000;

export interface MessageWindow {
  /** Sorted by (created, id); at most WINDOW_MAX after trimming. */
  items: Message[];
  /** false ⇒ items[0] is the room's very first message. */
  hasOlder: boolean;
  /** false ⇒ the window is at the live edge. */
  hasNewer: boolean;
}

export type PageKind = "latest" | "first" | "older" | "newer";
export type Side = "top" | "bottom";

export const emptyWindow = (): MessageWindow => ({ items: [], hasOlder: false, hasNewer: false });

export function compare(a: Message, b: Message): number {
  if (a.created !== b.created) return a.created < b.created ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Which of two copies of the same message to keep. */
function newest(current: Message, incoming: Message): Message {
  if (current.status && !incoming.status) return incoming; // server ack replaces optimistic copy
  if (!current.status && incoming.status) return current; // never regress to an optimistic copy
  return incoming.updated >= current.updated ? incoming : current;
}

/** Merge messages into the window: dedupe by id, keep the newest copy, keep (created, id) order. */
export function merge(win: MessageWindow, incoming: readonly Message[]): MessageWindow {
  if (!incoming.length) return win;
  const byId = new Map(win.items.map((m) => [m.id, m]));
  for (const m of incoming) {
    const cur = byId.get(m.id);
    byId.set(m.id, cur ? newest(cur, m) : m);
  }
  return { ...win, items: [...byId.values()].sort(compare) };
}

export function remove(win: MessageWindow, id: string): MessageWindow {
  const i = win.items.findIndex((m) => m.id === id);
  if (i < 0) return win;
  return { ...win, items: win.items.filter((_, j) => j !== i) };
}

/** Drop messages beyond `max` from one end. "bottom" drops the newest, "top" the oldest. */
export function trim(win: MessageWindow, side: Side, max = WINDOW_MAX): { win: MessageWindow; dropped: string[] } {
  const extra = win.items.length - max;
  if (extra <= 0) return { win, dropped: [] };
  if (side === "bottom") {
    return {
      win: { ...win, items: win.items.slice(0, max), hasNewer: true },
      dropped: win.items.slice(max).map((m) => m.id),
    };
  }
  return {
    win: { ...win, items: win.items.slice(extra), hasOlder: true },
    dropped: win.items.slice(0, extra).map((m) => m.id),
  };
}

/**
 * Apply a fetched page (in any order). "latest"/"first" reset the window; "older"/"newer" extend it and
 * trim the opposite end. A page shorter than PAGE_SIZE means that end of the history has been reached.
 */
export function applyPage(win: MessageWindow, page: readonly Message[], kind: PageKind): { win: MessageWindow; dropped: string[] } {
  const full = page.length >= PAGE_SIZE;
  switch (kind) {
    case "latest":
      return { win: merge({ items: [], hasOlder: full, hasNewer: false }, page), dropped: [] };
    case "first":
      return { win: merge({ items: [], hasOlder: false, hasNewer: full }, page), dropped: [] };
    case "older":
      return trim({ ...merge(win, page), hasOlder: full }, "bottom");
    case "newer":
      return trim({ ...merge(win, page), hasNewer: full }, "top");
  }
}

/** Does `cur` start a new author group after `prev`? (author change or a gap over 5 minutes) */
export function startsGroup(prev: Message | undefined, cur: Message): boolean {
  if (!prev || prev.author !== cur.author) return true;
  return parsePb(cur.created) - parsePb(prev.created) > GROUP_GAP_MS;
}

export function group(items: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  items.forEach((m, i) => {
    if (startsGroup(items[i - 1], m)) groups.push([m]);
    else groups[groups.length - 1]!.push(m);
  });
  return groups;
}

/** My newest message that can be edited (Up arrow in an empty composer). */
export function lastOwnEditable(win: MessageWindow, me: string): Message | undefined {
  for (let i = win.items.length - 1; i >= 0; i--) {
    const m = win.items[i]!;
    if (m.author === me && !m.deleted && !m.status) return m;
  }
  return undefined;
}
