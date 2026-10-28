import { describe, expect, it } from "vitest";
import { createCache, forgetGone } from "../../web/src/cache.ts";
import type { Message, Room, User } from "../../web/src/lib/types.ts";
import { type AppState, createStore, initialState } from "../../web/src/store.ts";
import { memoryCache } from "../support/api.ts";

describe("room cache without IndexedDB (§7.5)", () => {
  it("keeps nothing beyond the page, and never fails", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    const cache = createCache("test");
    cache.put("u", "r", { items: [], hasOlder: false });
    cache.clear();
    await expect(cache.get("u", "r")).resolves.toBeUndefined();
    await expect(createCache("test").get("u", "r")).resolves.toBeUndefined();
  });

  it("holds what was kept in memory while the page is open, for its user only", async () => {
    const cache = createCache("test");
    cache.put("u", "r", { items: [], hasOlder: true });
    await expect(cache.get("u", "r")).resolves.toMatchObject({ hasOlder: true });
    await expect(cache.get("other", "r")).resolves.toBeUndefined();
  });

  // IndexedDB may not get to write as the page goes (QA BUG-104): what is kept then is also written to localStorage.
  it("what is kept as the page goes reaches the next page, which takes it once", async () => {
    const cache = createCache("left-1");
    dispatchEvent(new Event("pagehide"));
    cache.put("u", "r", { items: [{ id: "m" }] as Message[], hasOlder: false });
    await expect(createCache("left-1").get("u", "r")).resolves.toMatchObject({ items: [{ id: "m" }] });
    await expect(createCache("left-1").get("u", "r")).resolves.toBeUndefined();
    dispatchEvent(new Event("pageshow"));
  });

  it("back from the back/forward cache, or after clear(), nothing is left for the next page", async () => {
    const a = createCache("left-2");
    dispatchEvent(new Event("pagehide"));
    a.put("u", "r", { items: [], hasOlder: false });
    dispatchEvent(new Event("pageshow"));
    await expect(createCache("left-2").get("u", "r")).resolves.toBeUndefined();
    const b = createCache("left-3");
    dispatchEvent(new Event("pagehide"));
    b.put("u", "r", { items: [], hasOlder: false });
    b.clear();
    dispatchEvent(new Event("pageshow"));
    await expect(createCache("left-3").get("u", "r")).resolves.toBeUndefined();
  });
});

describe("forgetGone (§7.5, QA BUG-101)", () => {
  const room = (id: string) => ({ id, name: id }) as Room;
  const kept = { items: [{ id: "m" }] as Message[], hasOlder: false };

  it("forgets the rooms that leave the loaded room list, not the others", async () => {
    const cache = memoryCache();
    const store = createStore<AppState>({ ...initialState(), user: { id: "u", name: "U" } as User, roomsStatus: "ready" });
    store.set({
      rooms: new Map([
        ["a", room("a")],
        ["b", room("b")],
      ]),
    });
    cache.put("u", "a", kept);
    cache.put("u", "b", kept);
    const off = forgetGone(cache, store);
    store.set({ rooms: new Map([["b", room("b")]]) });
    expect((await cache.get("u", "a"))?.items).toEqual([]);
    expect((await cache.get("u", "b"))?.items).toHaveLength(1);
    off();
  });

  it("leaves the cache alone while the list loads, and across a user change", async () => {
    const cache = memoryCache();
    const store = createStore<AppState>({ ...initialState(), user: { id: "u", name: "U" } as User, roomsStatus: "ready" });
    store.set({ rooms: new Map([["a", room("a")]]) });
    cache.put("u", "a", kept);
    forgetGone(cache, store);
    store.set({ roomsStatus: "loading", rooms: new Map() });
    store.set({ ...initialState(), roomsStatus: "ready" });
    expect((await cache.get("u", "a"))?.items).toHaveLength(1);
  });
});
