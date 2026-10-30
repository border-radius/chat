import { describe, expect, it } from "vitest";
import { dmClosed, isDm, otherMember, roomTitle } from "../../../web/src/lib/rooms.ts";
import type { Room } from "../../../web/src/lib/types.ts";

const me = { id: "me", name: "Me" };
const pub: Room = { id: "r", name: "general", archived: false, created_by: "me" };
const dm: Room = {
  id: "d",
  name: "",
  archived: false,
  created_by: "me",
  kind: "dm",
  members: ["bob", "me"],
  expand: { members: [me, { id: "bob", name: "Bob", avatar: "b.png" }] },
};

describe("room helpers (§16.5)", () => {
  it("titles public rooms #name and DMs after the other member", () => {
    expect(roomTitle(pub, me)).toBe("#general");
    expect(roomTitle(dm, me)).toBe("Bob");
    expect(roomTitle(dm, { id: "bob", name: "Bob" })).toBe("Me");
  });

  it("otherMember returns the expanded user, or Unknown when the expand is missing", () => {
    expect(otherMember(dm, me)).toEqual({ id: "bob", name: "Bob", avatar: "b.png" });
    expect(otherMember({ ...dm, expand: {} }, me)).toEqual({ id: "bob", name: "Unknown" });
    expect(roomTitle({ ...dm, expand: {} }, me)).toBe("Unknown");
    expect(otherMember(pub, me)).toBeUndefined();
  });

  it("isDm", () => {
    expect(isDm(dm)).toBe(true);
    expect(isDm(pub)).toBe(false);
    expect(isDm({ ...pub, kind: "public" })).toBe(false);
  });
});

describe("dmClosed (§16.7, QA BUG-178)", () => {
  it("says why a DM takes no messages: the other person, or you, take none", () => {
    expect(dmClosed(dm, me)).toBe("");
    expect(dmClosed(pub, me)).toBe("");
    expect(dmClosed(dm, null)).toBe("");
    const closed: Room = { ...dm, expand: { members: [me, { id: "bob", name: "Bob (B)", no_dms: true }] } };
    expect(dmClosed(closed, me)).toBe("Bob (B) doesn't take direct messages.");
    expect(dmClosed(dm, { ...me, no_dms: true })).toBe("You've turned off direct messages.");
  });
});
