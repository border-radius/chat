import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, avatarColor, initials } from "../../../web/src/lib/avatar.ts";

describe("initials (§15.4)", () => {
  it("takes the first letter of the first two words, upper-cased", () => {
    expect(initials("ada")).toBe("A");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  grace   brewster murray hopper ")).toBe("GB");
  });

  it("keeps emoji and combining marks whole", () => {
    expect(initials("👩‍💻 dev")).toBe("👩‍💻D");
    expect(initials("émile zola")).toBe("ÉZ");
  });

  it("is ? for a blank name", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});

describe("avatarColor (§15.4)", () => {
  it("is stable for an id and within the palette", () => {
    expect(avatarColor("abc123def456ghi")).toBe(avatarColor("abc123def456ghi"));
    expect(avatarColor("x")).toBeGreaterThanOrEqual(0);
    expect(avatarColor("x")).toBeLessThan(AVATAR_COLORS);
  });

  it("spreads ids across the palette", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => avatarColor(`user${i.toString(36).padStart(10, "0")}`)));
    expect(used.size).toBe(AVATAR_COLORS);
  });
});
