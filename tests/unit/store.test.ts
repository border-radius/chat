import { describe, expect, it, vi } from "vitest";
import type { Room } from "../../web/src/lib/types.ts";
import { type AppState, createStore, initialState, roomSections } from "../../web/src/store.ts";

const room = (id: string, name: string, p: Partial<Room> = {}): Room => ({ id, name, archived: false, created_by: "u1", ...p });

describe("createStore", () => {
  it("notifies subscribers with the new and previous state", () => {
    const s = createStore({ a: 1, b: "x" });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: "x" });
    expect(fn).toHaveBeenCalledWith({ a: 2, b: "x" }, { a: 1, b: "x" });
  });

  it("accepts an updater function", () => {
    const s = createStore({ n: 1 });
    s.set((st) => ({ n: st.n + 1 }));
    expect(s.get().n).toBe(2);
  });

  it("does not notify when nothing changed", () => {
    const s = createStore({ a: 1 });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    const s = createStore({ a: 1 });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set({ a: 2 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("never mutates the previous state object", () => {
    const s = createStore({ a: 1 });
    const before = s.get();
    s.set({ a: 2 });
    expect(before).toEqual({ a: 1 });
  });
});

describe("initialState", () => {
  it("starts logged out with no rooms", () => {
    expect(initialState()).toEqual({ user: null, rooms: new Map(), hidden: new Map(), roomsStatus: "idle", activeRoomId: null });
  });
});

describe("roomSections (§7.1)", () => {
  const state = (rooms: Room[], hidden: string[] = []): AppState => ({
    ...initialState(),
    rooms: new Map(rooms.map((r) => [r.id, r])),
    hidden: new Map(hidden.map((id) => [id, `h-${id}`])),
  });

  it("splits rooms into rooms, hidden and archived, each sorted by name (case-insensitive)", () => {
    const s = state(
      [
        room("1", "zeta"),
        room("2", "Alpha"),
        room("3", "beta"),
        room("4", "old", { archived: true }),
        room("5", "Ancient", { archived: true }),
        room("6", "noisy"),
        room("7", "Memes"),
      ],
      ["6", "7"],
    );
    const { rooms, hidden, archived } = roomSections(s);
    expect(rooms.map((r) => r.name)).toEqual(["Alpha", "beta", "zeta"]);
    expect(hidden.map((r) => r.name)).toEqual(["Memes", "noisy"]);
    expect(archived.map((r) => r.name)).toEqual(["Ancient", "old"]);
  });

  it("an archived room goes to Archived even when hidden", () => {
    const s = state([room("1", "gone", { archived: true })], ["1"]);
    expect(roomSections(s)).toEqual({ rooms: [], hidden: [], archived: [s.rooms.get("1")] });
  });

  it("a hide row for an unknown room is ignored", () => {
    const s = state([room("1", "a")], ["missing"]);
    expect(roomSections(s).hidden).toEqual([]);
  });

  it("returns the room records as-is: no unread counts or badge data (silent hide)", () => {
    const r = room("1", "quiet");
    const { hidden } = roomSections(state([r], ["1"]));
    expect(hidden[0]).toBe(r);
  });
});
