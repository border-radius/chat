import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES, EMOJI, RECENT_MAX, recentEmoji, rememberEmoji } from "../../../web/src/lib/emoji.ts";

/** pb_hooks/lib/emoji.js's set: its EMOJI lines, read as text (the file runs in PocketBase, not here). */
function serverEmoji(): string[] {
  const src = readFileSync("pb_hooks/lib/emoji.js", "utf8");
  const block = /const EMOJI = \[([\s\S]*?)\]\.join/.exec(src)![1]!;
  return [...block.matchAll(/"([^"]*)"/g)].flatMap((m) => m[1]!.split(" "));
}

describe("emoji (§20.1, §20.4)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("the server allows exactly the emoji the picker offers (pb_hooks/lib/emoji.js)", () => {
    expect(serverEmoji()).toEqual(CATEGORIES.flatMap((c) => c.emoji));
  });

  it("every emoji is offered once, as a single character on screen", () => {
    const all = CATEGORIES.flatMap((c) => c.emoji);
    expect(all.length).toBe(EMOJI.size);
    const graphemes = new Intl.Segmenter();
    for (const e of all) expect([...graphemes.segment(e)], e).toHaveLength(1);
  });

  it("remembers recently used emoji, newest first, without repeats, up to RECENT_MAX", () => {
    expect(recentEmoji()).toEqual([]);
    rememberEmoji("👍");
    rememberEmoji("🎉");
    rememberEmoji("👍");
    expect(recentEmoji()).toEqual(["👍", "🎉"]);
    for (const e of CATEGORIES[0]!.emoji.slice(0, RECENT_MAX + 5)) rememberEmoji(e);
    expect(recentEmoji()).toHaveLength(RECENT_MAX);
    expect(recentEmoji()[0]).toBe(CATEGORIES[0]!.emoji[RECENT_MAX + 4]);
  });

  it("ignores what isn't a picker emoji, and works without storage", () => {
    rememberEmoji("x");
    expect(recentEmoji()).toEqual([]);
    localStorage.setItem("chat.recentEmoji", JSON.stringify(["👍", 3, "<b>", "🎉"]));
    expect(recentEmoji()).toEqual(["👍", "🎉"]);
    localStorage.setItem("chat.recentEmoji", "{not json");
    expect(recentEmoji()).toEqual([]);
    localStorage.clear();
    // e.g. a private window, or site data blocked: every access throws
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => rememberEmoji("👍")).not.toThrow();
    expect(recentEmoji()).toEqual([]);
    blocked.mockRestore();
    expect(recentEmoji()).toEqual([]);
  });
});
