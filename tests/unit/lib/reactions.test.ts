import { describe, expect, it } from "vitest";
import { reactors, setReaction } from "../../../web/src/lib/reactions.ts";

describe("setReaction (§20.3, as pb_hooks/lib/reactions.js does it)", () => {
  const list = [
    { emoji: "👍", users: ["a", "b"] },
    { emoji: "🎉", users: ["b"] },
  ];

  it("adds to an emoji's people, or adds the emoji last", () => {
    expect(setReaction(list, "👍", "c", true)).toEqual([
      { emoji: "👍", users: ["a", "b", "c"] },
      { emoji: "🎉", users: ["b"] },
    ]);
    expect(setReaction(list, "❤️", "a", true)).toEqual([...list, { emoji: "❤️", users: ["a"] }]);
  });

  it("removes, dropping an emoji nobody uses any more", () => {
    expect(setReaction(list, "👍", "a", false)).toEqual([
      { emoji: "👍", users: ["b"] },
      { emoji: "🎉", users: ["b"] },
    ]);
    expect(setReaction(list, "🎉", "b", false)).toEqual([{ emoji: "👍", users: ["a", "b"] }]);
  });

  it("returns the same list when nothing changes", () => {
    expect(setReaction(list, "👍", "a", true)).toBe(list);
    expect(setReaction(list, "🎉", "a", false)).toBe(list);
    expect(setReaction(list, "❤️", "a", false)).toBe(list);
  });
});

describe("reactors", () => {
  const names = (id: string) => ({ a: "Ada", b: "Bob", c: "Cy", d: "Di", e: "Ed", f: "Flo", g: "Gus" })[id];

  it("names who reacted, you first", () => {
    expect(reactors(["me"], "me", names)).toBe("You");
    expect(reactors(["a", "me"], "me", names)).toBe("You and Ada");
    expect(reactors(["a", "b", "c"], "me", names)).toBe("Ada, Bob and Cy");
  });

  it("counts the people it can't name, and names at most five", () => {
    expect(reactors(["a", "x"], "me", names)).toBe("Ada and 1 other");
    expect(reactors(["a", "x", "y"], "me", names)).toBe("Ada and 2 others");
    expect(reactors(["x"], "me", names)).toBe("1 person");
    expect(reactors(["x", "y"], "me", names)).toBe("2 people");
    expect(reactors(["a", "b", "c", "d", "e", "f", "g"], "me", names)).toBe("Ada, Bob, Cy, Di, Ed and 2 others");
  });
});
