import { describe, expect, it } from "vitest";
import { PAGE_SIZE, first, latest, newer, older } from "../../../web/src/lib/cursor.ts";

const C = { created: "2026-10-10 12:00:00.000Z", id: "abc123def456ghi" };

describe("cursor query builders (§6)", () => {
  it("page size is 50", () => {
    expect(PAGE_SIZE).toBe(50);
  });

  it("latest: newest-first, room only", () => {
    expect(latest("r1")).toEqual({ filter: "room = {:room}", params: { room: "r1" }, sort: "-created,-id" });
  });

  it("first: oldest-first, room only", () => {
    expect(first("r1")).toEqual({ filter: "room = {:room}", params: { room: "r1" }, sort: "created,id" });
  });

  it("older: strictly before the cursor on (created, id), newest-first", () => {
    expect(older("r1", C)).toEqual({
      filter: "room = {:room} && (created < {:created} || (created = {:created} && id < {:id}))",
      params: { room: "r1", created: C.created, id: C.id },
      sort: "-created,-id",
    });
  });

  it("newer: strictly after the cursor on (created, id), oldest-first", () => {
    expect(newer("r1", C)).toEqual({
      filter: "room = {:room} && (created > {:created} || (created = {:created} && id > {:id}))",
      params: { room: "r1", created: C.created, id: C.id },
      sort: "created,id",
    });
  });

  it("only reads created/id from the cursor message", () => {
    const msg = { ...C, text: "ignored", room: "other" };
    expect(older("r1", msg).params).toEqual({ room: "r1", created: C.created, id: C.id });
  });

  it("never concatenates values into the filter", () => {
    const evil = `" || 1=1 || "`;
    const q = older(evil, { created: evil, id: evil });
    expect(q.filter).not.toContain(evil);
    expect(Object.values(q.params)).toEqual([evil, evil, evil]);
  });
});
