// The message window's shared vectors (shared/vectors/window.json): the web's lib/messages.ts and lib/cursor.ts. The
// app runs them in android/core/data/src/test/kotlin/chirkle/android/data/lib/WindowVectorsTest.kt.

import { describe, expect, it } from "vitest";
import vectors from "../../../shared/vectors/window.json" with { type: "json" };
import { type Cursor, changedIn, first, latest, newer, older, PAGE_SIZE, type PageQuery, withFiles } from "../../../web/src/lib/cursor.ts";
import {
  applyPage,
  emptyForward,
  emptyWindow,
  lastOwnEditable,
  lastSaved,
  type MessageWindow,
  merge,
  type PageKind,
  quoteText,
  remove,
  startsGroup,
  trim,
  WINDOW_MAX,
} from "../../../web/src/lib/messages.ts";
import type { Message } from "../../../web/src/lib/types.ts";
import { type MessageSpec, type Messages, message, messages } from "../../support/vectors.ts";

type Expect = {
  ids?: string[];
  count?: number;
  first?: string;
  last?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  dropped?: string[] | { count: number; first: string; last: string };
  copies?: { id: string; updated: string; text: string; status: string | null }[];
};
type Step = { op: string; kind?: string; messages?: Messages; id?: string; side?: string; max?: number; expect: Expect };

/** The window as the vectors describe it. */
function shown(win: MessageWindow, dropped: string[] | undefined, e: Expect) {
  const ids = win.items.map((m) => m.id);
  const flags = { hasOlder: win.hasOlder, hasNewer: win.hasNewer };
  const out: Expect = e.ids ? { ids, ...flags } : { count: ids.length, first: ids[0]!, last: ids.at(-1)!, ...flags };
  if (e.dropped)
    out.dropped = Array.isArray(e.dropped) ? dropped! : { count: dropped!.length, first: dropped![0]!, last: dropped!.at(-1)! };
  if (e.copies)
    out.copies = e.copies.map(({ id }) => {
      const m = win.items.find((x) => x.id === id)!;
      return { id, updated: m.updated, text: m.text, status: m.status ?? null };
    });
  return out;
}

describe("shared vectors: the message window (§7.5)", () => {
  it("has the web's page size and window", () => {
    expect([PAGE_SIZE, WINDOW_MAX]).toEqual([vectors.pageSize, vectors.windowMax]);
  });

  for (const c of vectors.window) {
    it(c.name, () => {
      const start = c.start as { messages: Messages; hasOlder: boolean; hasNewer: boolean } | null;
      let win = start ? merge({ items: [], hasOlder: start.hasOlder, hasNewer: start.hasNewer }, messages(start.messages)) : emptyWindow();
      (c.steps as Step[]).forEach((s, i) => {
        let dropped: string[] | undefined;
        if (s.op === "page") ({ win, dropped } = applyPage(win, messages(s.messages!), s.kind as PageKind));
        else if (s.op === "merge") win = merge(win, messages(s.messages!));
        else if (s.op === "remove") win = remove(win, s.id!);
        else ({ win, dropped } = trim(win, s.side as "top" | "bottom", s.max));
        expect(shown(win, dropped, s.expect), `step ${i + 1}`).toEqual(s.expect);
      });
    });
  }

  const msg = (o: object) => message(o as MessageSpec);
  const winOf = (items: object[]): MessageWindow => ({ items: items.map(msg), hasOlder: false, hasNewer: false });

  it("startsGroup", () => {
    for (const g of vectors.startsGroup) expect(startsGroup(g.prev ? msg(g.prev) : undefined, msg(g.cur))).toBe(g.output);
  });

  it("lastSaved and lastOwnEditable", () => {
    for (const c of vectors.lastSaved) expect(lastSaved(winOf(c.items))?.id ?? null).toBe(c.output);
    for (const c of vectors.lastOwnEditable) expect(lastOwnEditable(winOf(c.items), c.me)?.id ?? null).toBe(c.output);
  });

  it("quoteText and emptyForward", () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
    for (const q of vectors.quoteText) expect(quoteText({ text: q.text, deleted: q.deleted, files: files(q.files) })).toBe(q.output);
    for (const f of vectors.emptyForward)
      expect(emptyForward({ ...msg({ id: "f" }), forwarded_from: f.forwarded_from, text: f.text, files: files(f.files) } as Message)).toBe(
        f.output,
      );
  });

  it("page queries", () => {
    const of = (fn: string, c: { room: string; cursor?: Cursor; since?: string; from?: Cursor; to?: Cursor }): PageQuery =>
      fn === "latest"
        ? latest(c.room)
        : fn === "first"
          ? first(c.room)
          : fn === "older"
            ? older(c.room, c.cursor!)
            : fn === "newer"
              ? newer(c.room, c.cursor!)
              : changedIn(c.room, c.since!, c.from!, c.to!);
    for (const c of vectors.cursors) {
      const q = c.fn === "withFiles" ? withFiles(of((c as { of: string }).of, c)) : of(c.fn, c);
      expect(q, c.fn).toEqual(c.output);
    }
  });
});
