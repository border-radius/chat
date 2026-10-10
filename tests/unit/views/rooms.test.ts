import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../../../web/src/api.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { createStore, initialState, type AppState, type Store } from "../../../web/src/store.ts";
import { createRoomsView } from "../../../web/src/views/rooms.ts";
import { instrument, signedUp, uniq, type SignedUp } from "../../support/api.ts";

type Section = "rooms" | "hidden" | "archived";

describe("rooms view (§7.1, TODO Phase 4)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let navigate: ReturnType<typeof vi.fn<(hash: string) => void>>;
  let view: View | undefined;

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
    navigate = vi.fn();
  });
  afterEach(async () => {
    view?.unmount();
    view = undefined;
    root.remove();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  async function mount(api: Api = me.api) {
    view = createRoomsView({ api, store, navigate });
    view.mount(root, {});
    await vi.waitFor(() => expect(root.querySelector("[aria-busy='true']")).toBeNull());
  }

  const row = (room: Room) => root.querySelector<HTMLElement>(`[data-room-id="${room.id}"]`);
  const sectionOf = (room: Room): Section | null =>
    (row(room)?.closest<HTMLElement>("[data-section]")?.dataset.section as Section | undefined) ?? null;
  const section = (s: Section) => root.querySelector<HTMLElement>(`[data-section="${s}"]`)!;
  const names = (s: Section) => [...section(s).querySelectorAll("[data-room-id] a")].map((a) => a.textContent);
  const button = (scope: Element, label: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null;
  const menu = (room: Room) => row(room)!.querySelector<HTMLDetailsElement>("details")!;
  const action = (room: Room, label: string) => {
    menu(room).open = true;
    return button(row(room)!, label);
  };
  const room = (name = `room-${uniq()}`) => me.api.createRoom(name);

  describe("rendering", () => {
    it("shows rooms, hidden and archived sections, each sorted by name", async () => {
      const b = await room(`b-${uniq()}`);
      const a = await room(`A-${uniq()}`);
      const h = await room(`h-${uniq()}`);
      const x = await room(`x-${uniq()}`);
      await me.api.hideRoom(h.id);
      await me.api.setArchived(x.id, true);
      await mount();

      expect(sectionOf(a)).toBe("rooms");
      expect(sectionOf(b)).toBe("rooms");
      expect(sectionOf(h)).toBe("hidden");
      expect(sectionOf(x)).toBe("archived");
      const mine = names("rooms").filter((n) => n === a.name || n === b.name);
      expect(mine).toEqual([a.name, b.name]);
    });

    it("rooms link to their page; the active room is marked", async () => {
      const r = await room();
      store.set({ activeRoomId: r.id });
      await mount();
      const link = row(r)!.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(`#/r/${r.id}`);
      expect(link.getAttribute("aria-current")).toBe("page");
    });

    it("hidden and archived sections are collapsed, with a count", async () => {
      const h = await room();
      await me.api.hideRoom(h.id);
      await mount();
      for (const s of ["hidden", "archived"] as const) {
        const details = section(s).closest("details") ?? section(s).querySelector("details");
        expect(details, s).not.toBeNull();
        expect(details!.open, s).toBe(false);
      }
      const myHidden = (await me.api.listHidden()).length;
      expect(section("hidden").querySelector("summary")!.textContent).toBe(`Hidden (${myHidden})`);
    });

    it("shows an empty state when there are no rooms", async () => {
      const api = me.api;
      vi.spyOn(api, "listRooms").mockResolvedValue([]);
      await mount(api);
      expect(section("rooms").textContent).toContain("No rooms yet");
    });

    it("shows an error with a retry when loading fails", async () => {
      const ctl = instrument(me.api);
      ctl.failNext("listRooms", new ApiError("Failed to fetch", 0));
      const r = await room();
      await mount();
      const alert = root.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("Couldn't load rooms");
      button(root, "Retry")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
      expect(alert.textContent).toBe("");
    });
  });

  describe("creating", () => {
    it("creates a room, shows it, and opens it", async () => {
      await mount();
      const name = `new-${uniq()}`;
      const input = root.querySelector<HTMLInputElement>('form input[name="name"]')!;
      input.value = name;
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^#\/r\/[a-z0-9]{15}$/)));
      const id = navigate.mock.calls[0]![0].slice(4);
      expect(store.get().rooms.get(id)?.name).toBe(name);
      expect(root.querySelector(`[data-room-id="${id}"]`)).not.toBeNull();
      expect(input.value).toBe("");
    });

    it("shows a duplicate-name error inline and keeps the input", async () => {
      const taken = await room(`taken-${uniq()}`);
      await mount();
      const input = root.querySelector<HTMLInputElement>('form input[name="name"]')!;
      input.value = taken.name.toUpperCase();
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      const err = () => document.getElementById(input.getAttribute("aria-describedby")!)!;
      await vi.waitFor(() => expect(err().textContent).toBe("A room with this name already exists."));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe(taken.name.toUpperCase());
      expect(navigate).not.toHaveBeenCalled();
    });

    it("the name input enforces 1–48 characters in the browser", async () => {
      await mount();
      const input = root.querySelector<HTMLInputElement>('form input[name="name"]')!;
      expect(input.required).toBe(true);
      expect(input.getAttribute("maxlength")).toBe("48");
    });
  });

  describe("hide and unhide (§5.4)", () => {
    it("Hide moves a room to Hidden; Unhide moves it back", async () => {
      const r = await room();
      await mount();
      action(r, "Hide")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("hidden"));
      expect((await me.api.listHidden()).map((h) => h.room)).toContain(r.id);

      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
      expect((await me.api.listHidden()).map((h) => h.room)).not.toContain(r.id);
    });

    it("choosing an action closes the menu (it doesn't reappear open in the new section)", async () => {
      const r = await room();
      await mount();
      action(r, "Hide")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("hidden"));
      expect(menu(r).open).toBe(false);
      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
      expect(menu(r).open).toBe(false);
    });

    it("a hide from another tab (realtime) updates the sections", async () => {
      const r = await room();
      await mount();
      const otherTab = await signedUpSameUser();
      const row = await otherTab.hideRoom(r.id);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("hidden"));
      await otherTab.unhideRoom(row.id);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("new messages in a hidden room change nothing in the list (silent hide)", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      await mount();
      const before = section("hidden").innerHTML;
      await me.api.send({ id: newId(), room: r.id, text: "psst" });
      await new Promise((res) => setTimeout(res, 300));
      expect(section("hidden").innerHTML).toBe(before);
    });

    it("archived rooms offer no Hide action (archived wins)", async () => {
      const r = await room();
      await me.api.setArchived(r.id, true);
      await mount();
      expect(action(r, "Hide")).toBeNull();
    });
  });

  describe("archive and unarchive", () => {
    it("only the creator sees Archive", async () => {
      const other = await signedUp("Other");
      const theirs = await other.api.createRoom(`theirs-${uniq()}`);
      const mine = await room();
      await mount();
      expect(action(mine, "Archive")).not.toBeNull();
      expect(action(theirs, "Archive")).toBeNull();
      expect(action(theirs, "Hide")).not.toBeNull();
    });

    it("Archive asks for confirmation; only Confirm archives", async () => {
      const r = await room();
      const ctl = instrument(me.api);
      await mount();
      action(r, "Archive")!.click();
      expect(row(r)!.textContent).toContain("read-only for everyone");
      expect(ctl.calls("setArchived")).toBe(0);

      button(row(r)!, "Cancel")!.click();
      expect(ctl.calls("setArchived")).toBe(0);
      expect(button(row(r)!, "Archive room")).toBeNull();

      action(r, "Archive")!.click();
      button(row(r)!, "Archive room")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("archived"));
      expect(ctl.calls("setArchived")).toBe(1);
    });

    it("Unarchive moves it back", async () => {
      const r = await room();
      await me.api.setArchived(r.id, true);
      await mount();
      action(r, "Unarchive")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("an archive by the creator elsewhere (realtime) moves the room for everyone", async () => {
      const owner = await signedUp("Owner");
      const r = await owner.api.createRoom(`shared-${uniq()}`);
      await mount();
      expect(sectionOf(r)).toBe("rooms");
      await owner.api.setArchived(r.id, true);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("archived"));
      await owner.api.setArchived(r.id, false);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("a failed action shows an error and leaves the room where it was", async () => {
      const r = await room();
      instrument(me.api).failNext("hideRoom", new ApiError("Failed to fetch", 0));
      await mount();
      action(r, "Hide")!.click();
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toContain("Couldn't hide"));
      expect(sectionOf(r)).toBe("rooms");
    });
  });

  describe("realtime room list", () => {
    it("a room created elsewhere appears", async () => {
      await mount();
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`elsewhere-${uniq()}`);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("on reconnect the lists are reloaded (events may have been missed)", async () => {
      const ctl = instrument(me.api);
      await mount();
      expect(ctl.calls("listRooms")).toBe(1);
      ctl.reconnect();
      await vi.waitFor(() => expect(ctl.calls("listRooms")).toBe(2));
      expect(ctl.calls("listHidden")).toBe(2);
    });

    it("unmount unsubscribes and clears the view", async () => {
      const ctl = instrument(me.api);
      await mount();
      view!.unmount();
      view = undefined;
      expect(root.childNodes).toHaveLength(0);
      expect(ctl.calls("subscribeRooms")).toBe(1);
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`after-${uniq()}`);
      await new Promise((res) => setTimeout(res, 300));
      expect(store.get().rooms.has(r.id)).toBe(false);
    });

    it("events still in flight when unmounting are ignored (unsubscribe is async)", async () => {
      const handlers: ((action: "create", r: Room) => void)[] = [];
      const original = me.api.subscribeRooms.bind(me.api);
      vi.spyOn(me.api, "subscribeRooms").mockImplementation((fn) => {
        handlers.push(fn);
        return original(fn);
      });
      await mount();
      view!.unmount();
      view = undefined;
      handlers[0]!("create", { id: "zzzzzzzzzzzzzzz", name: "late", archived: false, created_by: "x" });
      expect(store.get().rooms.has("zzzzzzzzzzzzzzz")).toBe(false);
    });
  });

  /** A second client logged in as the same user ("another tab"). */
  async function signedUpSameUser(): Promise<Api> {
    const { newApi } = await import("../../support/api.ts");
    const api = newApi();
    await api.logIn(me.email, me.password);
    return api;
  }
});
