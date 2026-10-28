// Tests for tests/support/api.ts: real PocketBase clients plus vi.spyOn-based controls for view tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { latest } from "../../web/src/lib/cursor.ts";
import { newId } from "../../web/src/lib/id.ts";
import { instrument, newApi, seedMessages, signedUp } from "../support/api.ts";

afterEach(() => vi.restoreAllMocks());

describe("newApi / signedUp", () => {
  it("newApi is a logged-out real client with its own auth store", () => {
    expect(newApi().currentUser()).toBeNull();
  });

  it("signedUp creates a distinct, logged-in user each time", async () => {
    const a = await signedUp("Ada");
    const b = await signedUp();
    expect(a.user.name).toBe("Ada");
    expect(a.api.currentUser()).toEqual(a.user);
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.email).toMatch(/@test\.local$/);
  });
});

describe("seedMessages", () => {
  it("inserts messages oldest-first through the admin API, with distinct timestamps", async () => {
    const { api, user } = await signedUp();
    const room = await api.createRoom(`seed-${newId()}`);
    const msgs = await seedMessages(room.id, user.id, 120);
    expect(msgs.map((m) => m.text)).toEqual(Array.from({ length: 120 }, (_, i) => `msg ${i + 1}`));
    expect(new Set(msgs.map((m) => m.created)).size).toBe(120);
    const page = await api.page(latest(room.id));
    expect(page[0]!.id).toBe(msgs[119]!.id);
    expect(page[0]!.expand?.author?.name).toBe(user.name);
  });
});

describe("instrument", () => {
  it("counts calls per operation", async () => {
    const { api, user } = await signedUp();
    const ctl = instrument(api);
    await api.listRooms();
    await api.listRooms();
    expect(ctl.calls("listRooms")).toBe(2);
    expect(ctl.calls("page")).toBe(0);
    expect(api.currentUser()).toEqual(user);
  });

  it("failNext rejects the next call once, then calls through to the server", async () => {
    const { api } = await signedUp();
    const ctl = instrument(api);
    const room = await api.createRoom(`f-${newId()}`);
    ctl.failNext("send", new ApiError("boom", 500));
    await expect(api.send({ id: newId(), room: room.id, text: "x" })).rejects.toMatchObject({ status: 500 });
    await expect(api.send({ id: newId(), room: room.id, text: "y" })).resolves.toMatchObject({ text: "y" });
  });

  it("hold pauses an operation until released", async () => {
    const { api } = await signedUp();
    const ctl = instrument(api);
    const room = await api.createRoom(`h-${newId()}`);
    const release = ctl.hold("page");
    let done = false;
    const p = api.page(latest(room.id)).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });

  it("reconnect() replays onConnect handlers with reconnect=true", async () => {
    const { api } = await signedUp();
    const ctl = instrument(api);
    const fn = vi.fn();
    const off = api.onConnect(fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledWith(false));
    ctl.reconnect();
    expect(fn).toHaveBeenLastCalledWith(true);
    off();
    ctl.reconnect();
    expect(fn).toHaveBeenCalledTimes(2);
    await api.unsubscribeAll();
  });
});
