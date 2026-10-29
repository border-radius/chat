import { describe, expect, it } from "vitest";
import { changedIn, first, latest, newer, older, PAGE_SIZE, withFiles } from "../../../web/src/lib/cursor.ts";

const C = { created: "2026-10-10 12:00:00.000Z", id: "abc123def456ghi" };

describe("cursor page builders (§6)", () => {
  it("page size is 50", () => {
    expect(PAGE_SIZE).toBe(50);
  });

  it("latest and first: the room only", () => {
    expect(latest("r1")).toEqual({ room: "r1", kind: "latest", args: {} });
    expect(first("r1")).toEqual({ room: "r1", kind: "first", args: {} });
  });

  it("older and newer: the cursor's created and id", () => {
    expect(older("r1", C)).toEqual({ room: "r1", kind: "older", args: { created: C.created, id: C.id } });
    expect(newer("r1", C)).toEqual({ room: "r1", kind: "newer", args: { created: C.created, id: C.id } });
  });

  it("changedIn: since, and the window's ends by created", () => {
    const to = { created: "2026-10-10 13:00:00.000Z", id: "z" };
    expect(changedIn("r1", "2026-10-10 12:30:00.000Z", C, to)).toEqual({
      room: "r1",
      kind: "changed",
      args: { since: "2026-10-10 12:30:00.000Z", from: C.created, to: to.created },
    });
  });

  it("withFiles: the same page, of messages with attachments only", () => {
    const q = older("r1", C);
    expect(withFiles(q)).toEqual({ ...q, files: true });
  });

  it("only reads created/id from the cursor message", () => {
    const msg = { ...C, text: "ignored", room: "other" };
    expect(older("r1", msg).args).toEqual({ created: C.created, id: C.id });
  });
});
