import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Action, type Api, ApiError } from "../../../web/src/api.ts";
import { h } from "../../../web/src/dom.ts";
import { createDrafts } from "../../../web/src/drafts.ts";
import { newId } from "../../../web/src/lib/id.ts";
import { dayLabel, parsePb } from "../../../web/src/lib/time.ts";
import type { Message, Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, bumpUnread, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { HIGHLIGHT_MS } from "../../../web/src/views/room/controller.ts";
import { createRoomView, NOTICE_MS } from "../../../web/src/views/room.ts";
import {
  instrument,
  intercept,
  READ_WINDOW_MS,
  type SignedUp,
  seedMessages,
  signedUp,
  subscribed,
  uniq,
  viewContext,
} from "../../support/api.ts";
import { fakeLayout, installIntersectionObserver } from "../../support/dom.ts";
import { pngFile } from "../../support/files.ts";

const ROW = 40;
const VIEWPORT = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("room view (§7.5–7.6)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let navigate: ReturnType<typeof vi.fn<(hash: string) => void>>;
  let view: View | undefined;
  let io: ReturnType<typeof installIntersectionObserver>;
  let layout: ReturnType<typeof fakeLayout>;

  beforeEach(async () => {
    io = installIntersectionObserver();
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
    io.restore();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  // ---- helpers ----

  const list = () => root.querySelector<HTMLOListElement>("ol.messages")!;
  const msgEls = () => [...root.querySelectorAll<HTMLElement>("li.msg")];
  const ids = () => msgEls().map((el) => el.dataset.id!);
  const msgEl = (id: string) => root.querySelector<HTMLElement>(`li.msg[data-id="${id}"]`);
  const bodyOf = (id: string) => msgEl(id)?.querySelector(".body")?.textContent ?? null;
  const sentinel = (which: "top" | "bottom") => root.querySelector<HTMLElement>(`li.sentinel[data-sentinel="${which}"]`);
  const beginning = () => root.querySelector("li.beginning");
  const pill = () => root.querySelector<HTMLButtonElement>("button.new-messages")!;
  const composer = () => root.querySelector<HTMLTextAreaElement>("form.composer textarea");
  const sendButton = () => root.querySelector<HTMLButtonElement>("form.composer button[type='submit']")!;
  const button = (scope: Element | null, label: string) =>
    scope ? ([...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null) : null;
  const key = (el: Element, k: string, opts: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  const type = (text: string) => {
    const t = composer()!;
    t.value = text;
    t.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const send = (text: string) => {
    type(text);
    key(composer()!, "Enter");
  };
  const loaded = () => vi.waitFor(() => expect(list().getAttribute("aria-busy")).toBe("false"));
  const atBottom = () => list().scrollTop === Math.max(0, list().scrollHeight - VIEWPORT);
  const headerMenu = () => {
    const d = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
    d.open = true;
    return d;
  };

  async function newRoom(owner: SignedUp = me): Promise<Room> {
    return owner.api.createRoom(`room-${uniq()}`);
  }

  async function mount(room: Room, params: Record<string, string> = {}, api: Api = me.api) {
    view = createRoomView(viewContext(api, store, navigate));
    view.mount(root, { id: room.id, ...params });
    layout = fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
    await loaded();
    await subscribed(api); // live events caused from here on reach the view
  }

  /**
   * Drop realtime message events while `offline` is true (to simulate a dropped connection). `dropped` counts them, so
   * a test can wait until the events it caused really were lost (instead of sleeping and hoping they came already).
   */
  function gateRealtime(api: Api) {
    const state = { offline: false, dropped: 0 };
    intercept(
      api,
      "subscribeMessages",
      (original) => (roomId, fn) =>
        original(roomId, (action, rec) => {
          if (state.offline) state.dropped++;
          else fn(action, rec);
        }),
    );
    return state;
  }

  /** Ids of the message events the view's subscription has received (to wait for one deterministically). */
  function deliveries(api: Api) {
    const ids: string[] = [];
    intercept(
      api,
      "subscribeMessages",
      (original) => (roomId, fn) =>
        original(roomId, (action, rec) => {
          ids.push(rec.id);
          fn(action, rec);
        }),
    );
    return ids;
  }

  /** Capture the view's realtime message handler so tests can inject events directly. */
  function captureHandler(api: Api) {
    const handlers: ((action: Action, m: Message) => void)[] = [];
    intercept(api, "subscribeMessages", (original) => (roomId, fn) => {
      handlers.push(fn);
      return original(roomId, fn);
    });
    return handlers;
  }

  // ---- 5.1 ----

  describe("initial load (5.1)", () => {
    it("renders the latest 50 messages oldest-first, with a top sentinel for older history", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 120);
      await mount(room);
      expect(ids()).toEqual(seeded.slice(70).map((m) => m.id));
      expect(io.observing(sentinel("top"))).toBe(true);
      expect(beginning()).toBeNull();
      expect(sentinel("bottom")).toBeNull();
    });

    it("a short history shows the beginning marker instead of a top sentinel", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 3);
      await mount(room);
      expect(beginning()!.textContent).toBe(`Beginning of #${room.name}`);
      expect(sentinel("top")).toBeNull();
    });

    it("groups consecutive messages by author and shows author + time once per group", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const t0 = Date.now() - 600_000;
      await seedMessages(room.id, me.user.id, 3, { startAt: t0 });
      await seedMessages(room.id, other.user.id, 2, { startAt: t0 + 10_000 });
      await mount(room);
      const starts = msgEls().map((el) => el.classList.contains("group-start"));
      expect(starts).toEqual([true, false, false, true, false]);
      const first = msgEls()[0]!;
      expect(first.querySelector(".author")!.textContent).toBe("Me");
      expect(first.querySelector("time")!.getAttribute("datetime")).toBeTruthy();
      expect(msgEls()[1]!.querySelector(".author")).toBeNull();
    });

    it("inserts a date divider between days", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 4, { stepMs: 20 * 3_600_000 });
      await mount(room);
      const dividerEls = [...root.querySelectorAll("li.day")];
      // plain list items: a role override would break the <ol> list semantics (axe "list" rule)
      expect(dividerEls.every((d) => !d.hasAttribute("role"))).toBe(true);
      const dividers = dividerEls.map((d) => d.textContent);
      const expected = [...new Set(seeded.map((m) => dayLabel(parsePb(m.created))))];
      expect(expected.length).toBeGreaterThanOrEqual(3);
      expect(dividers).toEqual(expected);
    });

    it("starts scrolled to the bottom", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 60);
      await mount(room);
      expect(list().scrollHeight).toBeGreaterThan(VIEWPORT);
      expect(atBottom()).toBe(true);
    });

    it("shows the room name, marks the room active, and clears it on unmount", async () => {
      const room = await newRoom();
      await mount(room);
      expect(root.querySelector("header.room-header h1")!.textContent).toBe(`#${room.name}`);
      expect(store.get().activeRoomId).toBe(room.id);
      view!.unmount();
      view = undefined;
      expect(store.get().activeRoomId).toBeNull();
      expect(root.childNodes).toHaveLength(0);
    });

    it("subscribes and fetches the first page in parallel", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      const release = ctl.hold("page");
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: room.id });
      await vi.waitFor(() => expect(ctl.calls("subscribeMessages")).toBe(1));
      expect(ctl.calls("page")).toBe(1);
      release();
      await loaded();
    });

    it("QA BUG-61: a message sent after the first page was read, before realtime was set up, still shows", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      // The server only gets the subscription once the gate opens: the page is read first.
      intercept(me.api, "subscribeMessages", (original) => async (roomId, fn) => {
        await gate;
        return original(roomId, fn);
      });
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: room.id });
      layout = fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
      await loaded();
      const m = await other.api.send({ id: newId(), room: room.id, text: "in the gap" });
      open();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("in the gap"));
      await other.api.unsubscribeAll();
    });

    it("an unknown room shows a not-found message", async () => {
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: "doesnotexist123" });
      await vi.waitFor(() => expect(root.textContent).toContain("This room doesn't exist."));
      expect(composer()).toBeNull();
    });

    it("unmount cancels the room's pending reads", async () => {
      const room = await newRoom();
      const signals: (AbortSignal | undefined)[] = [];
      intercept(me.api, "getRoom", (original) => (id, signal) => {
        signals.push(signal);
        return original(id, signal);
      });
      intercept(me.api, "page", (original) => (q, signal) => {
        signals.push(signal);
        return original(q, signal);
      });
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: room.id });
      expect(signals).toHaveLength(2);
      expect(signals.every((s) => s && !s.aborted)).toBe(true);
      view.unmount();
      view = undefined;
      expect(signals.every((s) => s!.aborted)).toBe(true);
    });

    it("unmount unsubscribes and ignores events still in flight", async () => {
      const room = await newRoom();
      const handlers = captureHandler(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      view!.unmount();
      view = undefined;
      handlers[0]!("create", {
        id: newId(),
        room: room.id,
        author: "x",
        text: "late",
        created: "",
        updated: "",
        edited_at: "",
        deleted: false,
      });
      expect(root.childNodes).toHaveLength(0);
      expect(ctl.calls("subscribeMessages")).toBe(1);
    });
  });

  // ---- 5.2 ----

  describe("composer and optimistic send (5.2)", () => {
    it("Enter sends; the message shows immediately as pending, then confirmed, never duplicated", async () => {
      const room = await newRoom();
      const delivered = deliveries(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      send("hello world");
      const pending = msgEls().at(-1)!;
      expect(pending.querySelector(".body")!.textContent).toBe("hello world");
      expect(pending.classList.contains("pending")).toBe(true);
      expect(composer()!.value).toBe("");
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      await vi.waitFor(() => expect(delivered).toContain(id)); // the realtime echo of our own message
      expect(ids().filter((x) => x === id)).toHaveLength(1);
      expect(atBottom()).toBe(true);
    });

    it("Shift+Enter inserts a newline instead of sending", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      type("line 1");
      const ev = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
      composer()!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(ctl.calls("send")).toBe(0);
    });

    it("blocks empty, whitespace-only and over-long messages", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      expect(sendButton().disabled).toBe(true);
      type("   \n ");
      expect(sendButton().disabled).toBe(true);
      key(composer()!, "Enter");
      type("x".repeat(2001));
      expect(sendButton().disabled).toBe(true);
      key(composer()!, "Enter");
      expect(ctl.calls("send")).toBe(0);
      type("ok");
      expect(sendButton().disabled).toBe(false);
    });

    it("shows a character counter only past 1800 characters", async () => {
      const room = await newRoom();
      await mount(room);
      const counter = () => root.querySelector("form.composer .counter")!;
      type("x".repeat(1800));
      expect(counter().textContent).toBe("");
      type("x".repeat(1900));
      expect(counter().textContent).toBe("100 left");
      type("x".repeat(2010));
      expect(counter().textContent).toBe("10 over");
    });

    it("a failed send is marked, keeps its text, and Retry resends with the same id", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("Failed to fetch", 0));
      await mount(room);
      send("try me");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const el = msgEls().at(-1)!;
      const id = el.dataset.id!;
      expect(el.querySelector(".body")!.textContent).toBe("try me");
      expect(el.textContent).toContain("Not sent.");
      button(el, "Retry")!.click();
      await vi.waitFor(() => {
        expect(msgEl(id)!.classList.contains("failed")).toBe(false);
        expect(msgEl(id)!.classList.contains("pending")).toBe(false);
      });
      const calls = vi.mocked(me.api.send).mock.calls.map(([m]) => m.id);
      expect(calls).toEqual([id, id]);
    });

    it("a retry after a send that actually reached the server is treated as sent", async () => {
      const room = await newRoom();
      // No realtime echo: otherwise the echo itself (correctly) marks the message sent before we can retry.
      gateRealtime(me.api).offline = true;
      let first = true;
      intercept(me.api, "send", (original) => async (m) => {
        const res = await original(m);
        if (first) {
          first = false;
          throw new ApiError("Failed to fetch", 0); // committed, but the response was lost
        }
        return res;
      });
      await mount(room);
      send("committed");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const id = msgEls().at(-1)!.dataset.id!;
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => {
        expect(msgEl(id)!.classList.contains("failed")).toBe(false);
        expect(msgEl(id)!.classList.contains("pending")).toBe(false);
      });
      expect(msgEl(id)!.textContent).not.toContain("Not sent.");
      expect(ids().filter((x) => x === id)).toHaveLength(1);
    });

    it("Discard removes a failed message without a request", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("Failed to fetch", 0));
      await mount(room);
      send("nope");
      await vi.waitFor(() => expect(msgEls().at(-1)?.classList.contains("failed")).toBe(true));
      button(msgEls().at(-1)!, "Discard")!.click();
      expect(msgEls()).toHaveLength(0);
      expect(ctl.calls("send")).toBe(1);
    });
  });

  // ---- 5.3 ----

  describe("live updates and scrolling (5.3)", () => {
    it("at the bottom, a new message is appended and the view follows it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      const m = await other.api.send({ id: newId(), room: room.id, text: "hi from other" });
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });

    it("scrolled up, a new message shows the pill instead of scrolling; the pill returns to the bottom", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      layout.scrollTo(0);
      const m = await other.api.send({ id: newId(), room: room.id, text: "while you read" });
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(list().scrollTop).toBe(0);
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("↓ New messages");
      pill().click();
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });

    it("scrolling back to the bottom hides the pill", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      layout.scrollTo(0);
      await other.api.send({ id: newId(), room: room.id, text: "ping" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      layout.scrollToBottom();
      expect(pill().hidden).toBe(true);
    });
  });

  // ---- 5.4 ----

  describe("windowed history (5.4)", () => {
    /** Assert the DOM shows a contiguous slice of `all`, and return it. */
    function contiguous(all: Message[]): Message[] {
      const shown = ids();
      const start = all.findIndex((m) => m.id === shown[0]);
      expect(start).toBeGreaterThanOrEqual(0);
      const slice = all.slice(start, start + shown.length);
      expect(shown).toEqual(slice.map((m) => m.id));
      return slice;
    }

    it("loading older messages keeps what you were looking at in place", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      await mount(room);
      layout.scrollTo(3 * ROW);
      const anchorId = msgEls().find((el) => el.offsetTop >= list().scrollTop)!.dataset.id!;
      const before = msgEl(anchorId)!.offsetTop - list().scrollTop;
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
      expect(msgEl(anchorId)!.offsetTop - list().scrollTop).toBe(before);
    });

    it("loading older messages from the very top keeps the view in place, so scrolling up keeps loading", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      await mount(room);
      layout.scrollTo(0); // the top message is the anchor; prepending changes its grouping and rebuilds it
      const firstId = ids()[0]!;
      const before = msgEl(firstId)!.offsetTop - list().scrollTop;
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
      expect(list().scrollTop).toBeGreaterThan(0);
      expect(msgEl(firstId)!.offsetTop - list().scrollTop).toBe(before);
    });

    it("away from the live edge, new messages show 'Jump to latest' instead of being appended", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await mount(room, { msgId: all[20]!.id });
      const m = await other.api.send({ id: newId(), room: room.id, text: "meanwhile" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      expect(pill().textContent).toBe("New messages · Jump to latest");
      expect(ids()).not.toContain(m.id);
      pill().click();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(sentinel("bottom")).toBeNull();
      expect(pill().hidden).toBe(true);
      expect(atBottom()).toBe(true);
    });

    it("Jump to beginning loads the first page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await mount(room);
      button(headerMenu(), "Jump to beginning")!.click();
      await vi.waitFor(() => expect(beginning()).not.toBeNull());
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(sentinel("bottom")).not.toBeNull();
      expect(list().scrollTop).toBe(0);
    });

    it("#/r/:id/m/:msgId opens a window around that message and highlights it", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const target = all[150]!;
      await mount(room, { msgId: target.id });
      expect(ids()).toContain(all[149]!.id);
      expect(ids()).toContain(all[151]!.id);
      contiguous(all);
      expect(msgEl(target.id)!.classList.contains("target")).toBe(true);
      expect(sentinel("top")).not.toBeNull();
      expect(sentinel("bottom")).not.toBeNull();
    });
  });

  // ---- 5.5 ----

  describe("reconnects (5.5)", () => {
    it("a reconnect refetches the room, so an archive missed while offline takes effect", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      intercept(me.api, "subscribeRooms", () => async () => async () => {}); // no live room events
      await mount(room);
      await me.api.setArchived(room.id, true);
      await sleep(200);
      expect(composer()).not.toBeNull();
      ctl.reconnect();
      await vi.waitFor(() => expect(composer()).toBeNull());
      expect(root.textContent).toContain("This room is archived. History is read-only.");
    });
  });

  // ---- 5.6 ----

  describe("editing (5.6)", () => {
    const editBox = (id: string) => msgEl(id)?.querySelector<HTMLTextAreaElement>("textarea.edit-input") ?? null;

    it("Edit opens a prefilled box; Enter saves and marks the message (edited)", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "frist" });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(editBox(m.id)!.value).toBe("frist");
      editBox(m.id)!.value = "first";
      key(editBox(m.id)!, "Enter");
      await vi.waitFor(() => expect(msgEl(m.id)!.querySelector(".edited")).not.toBeNull());
      expect(bodyOf(m.id)).toBe("first");
      expect(editBox(m.id)).toBeNull();
      expect(msgEl(m.id)!.querySelector(".edited")!.getAttribute("title")).toBeTruthy();
    });

    it("Esc cancels without a request; unchanged text saves nothing", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "same" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "changed";
      key(editBox(m.id)!, "Escape");
      expect(bodyOf(m.id)).toBe("same");
      button(msgEl(m.id), "Edit")!.click();
      key(editBox(m.id)!, "Enter");
      expect(editBox(m.id)).toBeNull();
      expect(ctl.calls("edit")).toBe(0);
    });

    it("a failed save restores the old text and offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "old" });
      const ctl = instrument(me.api);
      ctl.failNext("edit", new ApiError("Failed to fetch", 0));
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "new";
      key(editBox(m.id)!, "Enter");
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't save your edit."));
      expect(bodyOf(m.id)).toBe("old");
      button(msgEl(m.id), "Retry")!.click();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("new"));
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't save");
    });

    it("Up arrow in an empty composer edits my last message, skipping deleted ones", async () => {
      const room = await newRoom();
      const keep = await me.api.send({ id: newId(), room: room.id, text: "editable" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.softDelete(gone.id);
      await mount(room);
      key(composer()!, "ArrowUp");
      expect(editBox(keep.id)).not.toBeNull();
      expect(document.activeElement).toBe(editBox(keep.id));
    });

    it("my forwards have Delete but no Edit, and Up arrow skips them (§21.3)", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const [copy] = await me.api.forward([theirs.id], room.id);
      await mount(room);
      expect(button(msgEl(copy!.id), "Edit")).toBeNull();
      expect(button(msgEl(copy!.id), "Delete")).not.toBeNull();
      key(composer()!, "ArrowUp");
      expect(editBox(mine.id)).not.toBeNull();
    });

    it("others' messages have no Edit or Delete", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      await mount(room);
      expect(button(msgEl(theirs.id), "Edit")).toBeNull();
      expect(button(msgEl(theirs.id), "Delete")).toBeNull();
    });

    it("an edit by someone else updates the message in place", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "v1" });
      await mount(room);
      await other.api.edit(m.id, "v2");
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("v2"));
      expect(msgEl(m.id)!.querySelector(".edited")).not.toBeNull();
    });
  });

  // ---- 5.7 ----

  describe("soft delete (5.7)", () => {
    it("Delete asks first; Cancel does nothing; Confirm leaves a placeholder with author and time", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "regret" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      expect(msgEl(m.id)!.textContent).toContain("Delete this message?");
      button(msgEl(m.id), "Cancel")!.click();
      expect(ctl.calls("softDelete")).toBe(0);
      expect(bodyOf(m.id)).toBe("regret");

      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      expect(bodyOf(m.id)).toBe("Message deleted");
      await vi.waitFor(() => expect(ctl.calls("softDelete")).toBe(1));
      const el = msgEl(m.id)!;
      expect(el.classList.contains("deleted")).toBe(true);
      expect(el.querySelector(".author")!.textContent).toBe("Me");
      expect(el.querySelector("time")).not.toBeNull();
      expect(button(el, "Edit")).toBeNull();
      expect(button(el, "Delete")).toBeNull();
      expect(el.querySelector(".edited")).toBeNull();
    });

    it("a failed delete restores the message and says so", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "stay" });
      instrument(me.api).failNext("softDelete", new ApiError("Failed to fetch", 0));
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't delete this message."));
      expect(bodyOf(m.id)).toBe("stay");
      expect(msgEl(m.id)!.classList.contains("deleted")).toBe(false);
    });

    it("a delete by someone else turns into a placeholder live", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "oops" });
      await mount(room);
      await other.api.softDelete(m.id);
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("Message deleted"));
    });

    it("a hard delete (superuser) removes the message", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "purged" });
      const handlers = captureHandler(me.api);
      await mount(room);
      handlers[0]!("delete", m);
      expect(msgEl(m.id)).toBeNull();
    });
  });

  // ---- 5.8 + header ----

  describe("archived rooms (5.8)", () => {
    it("show a read-only banner instead of the composer, with no message actions", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "history" });
      await me.api.setArchived(room.id, true);
      await mount(room);
      expect(composer()).toBeNull();
      expect(root.querySelector(".archived-banner")!.textContent).toBe("This room is archived. History is read-only.");
      expect(button(msgEl(m.id), "Edit")).toBeNull();
      expect(button(msgEl(m.id), "Delete")).toBeNull();
    });

    it("history in an archived room still loads older pages", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 120);
      await me.api.setArchived(room.id, true);
      await mount(room);
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
    });

    it("archiving while the room is open switches it to read-only live; unarchiving restores the composer", async () => {
      const owner = await signedUp("Owner");
      const room = await newRoom(owner);
      await mount(room);
      expect(composer()).not.toBeNull();
      await owner.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(composer()).toBeNull());
      await owner.api.setArchived(room.id, false);
      await vi.waitFor(() => expect(composer()).not.toBeNull());
    });
  });

  describe("keyboard and accessibility (Phase 6)", () => {
    const active = () => document.activeElement as HTMLElement | null;

    it("the room is a region labelled by its name, with a link back to the room list", async () => {
      const room = await newRoom();
      await mount(room);
      const region = root.querySelector("section.room")!;
      const h1 = region.querySelector("h1")!;
      expect(region.getAttribute("aria-labelledby")).toBe(h1.id);
      const back = root.querySelector<HTMLAnchorElement>("header.room-header a.back")!;
      expect(back.getAttribute("href")).toBe("#/");
      expect(back.textContent).toContain("Rooms");
    });

    it("message actions are real buttons in the tab order", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      await mount(room);
      for (const label of ["Edit", "Delete"]) {
        const b = button(msgEl(m.id), label)!;
        expect(b.tagName).toBe("BUTTON");
        expect(b.getAttribute("tabindex")).toBeNull();
        expect(b.hidden).toBe(false);
      }
    });

    it("the delete confirm focuses Cancel; Escape cancels and returns focus to Delete", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "keep me" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      expect(active()).toBe(button(msgEl(m.id), "Cancel"));
      key(active()!, "Escape");
      expect(msgEl(m.id)!.textContent).not.toContain("Delete this message?");
      expect(active()).toBe(button(msgEl(m.id), "Delete"));
      expect(ctl.calls("softDelete")).toBe(0);
    });

    it("Escape closes the header menu and returns focus to its toggle", async () => {
      const room = await newRoom();
      await mount(room);
      const menu = headerMenu();
      button(menu, "Jump to beginning")!.focus();
      key(active()!, "Escape");
      const details = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
      expect(details.open).toBe(false);
      expect(active()).toBe(details.querySelector("summary"));
    });

    it("the archive confirm in the header focuses Cancel; Escape cancels", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      button(headerMenu(), "Archive room")!.click();
      const details = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
      expect(active()).toBe(button(details, "Cancel"));
      key(active()!, "Escape");
      const after = root.querySelector<HTMLDetailsElement>("header.room-header details")!; // header re-rendered
      expect(after.open).toBe(false);
      expect(after.textContent).not.toContain("read-only for everyone");
      expect(active()).toBe(after.querySelector("summary"));
      expect(ctl.calls("setArchived")).toBe(0);
    });

    it("the edit box is labelled and Escape returns focus to the composer", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "edit me" });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(active()!.getAttribute("aria-label")).toBe("Edit message");
      key(active()!, "Escape");
      expect(active()).toBe(composer());
    });

    describe("focusing the window", () => {
      const refocus = () => window.dispatchEvent(new Event("focus"));
      const blur = () => (document.activeElement as HTMLElement | null)?.blur();
      afterEach(() => getSelection()?.removeAllRanges());

      it("focuses the composer when nothing (or a link) has focus", async () => {
        const room = await newRoom();
        await mount(room);
        blur();
        refocus();
        expect(active()).toBe(composer());
        const link = h("a", { href: "#/" }, "a link");
        root.append(link);
        link.focus();
        refocus();
        expect(active()).toBe(composer());
      });

      it("leaves focus on an edit box, a confirm or a menu", async () => {
        const room = await newRoom();
        const m = await me.api.send({ id: newId(), room: room.id, text: "edit me" });
        await mount(room);
        button(msgEl(m.id), "Edit")!.click();
        const edit = active();
        refocus();
        expect(active()).toBe(edit);
        key(edit!, "Escape");
        button(msgEl(m.id), "Delete")!.click();
        refocus();
        expect(active()).toBe(button(msgEl(m.id), "Cancel"));
        key(active()!, "Escape");
        const toggle = headerMenu().querySelector("summary")!;
        toggle.focus();
        refocus();
        expect(active()).toBe(toggle);
      });

      it("keeps a text selection (you may be copying it)", async () => {
        const room = await newRoom();
        const m = await me.api.send({ id: newId(), room: room.id, text: "copy me" });
        await mount(room);
        blur();
        getSelection()!.selectAllChildren(msgEl(m.id)!.querySelector(".body")!);
        refocus();
        expect(active()).not.toBe(composer());
        expect(String(getSelection())).toContain("copy me");
      });

      it("does nothing in an archived room", async () => {
        const room = await newRoom();
        await me.api.setArchived(room.id, true);
        await mount(room);
        blur();
        refocus();
        expect(composer()).toBeNull();
        expect(active()).toBe(document.body);
      });

      it("stops when the room is left", async () => {
        await mount(await newRoom());
        const focus = vi.spyOn(composer()!, "focus");
        view!.unmount();
        refocus();
        expect(focus).not.toHaveBeenCalled();
      });
    });
  });

  describe("read state (§18.3)", () => {
    /** Calls to api.markRead, as [room, at]. */
    function reads(api: Api) {
      const calls: [string, string][] = [];
      intercept(api, "markRead", (original) => (room, at) => {
        calls.push([room, at]);
        return original(room, at);
      });
      return calls;
    }
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    afterEach(() => {
      Reflect.deleteProperty(document, "visibilityState");
    });

    it("opening a room marks it read up to its newest message, on the server and in the store", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      // After my signup (older messages never count) and before now (a read is never later than now).
      const all = await seedMessages(room.id, other.user.id, 3, { stepMs: 1, startAt: Date.now() - 5 });
      expect((await me.api.unreadCounts()).rooms[room.id]).toBe(3);
      store.set(bumpUnread(room.id));
      const calls = reads(me.api);
      await mount(room);
      expect(store.get().unread.has(room.id)).toBe(false);
      await vi.waitFor(() => expect(calls).toEqual([[room.id, all[2]!.created]]), { timeout: 3000 });
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[room.id]).toBeUndefined());
    });

    it("live messages are read as they arrive, batched into one request", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      const calls = reads(me.api);
      const handlers = captureHandler(me.api);
      await mount(room);
      expect(calls).toEqual([]); // nothing to read in an empty room
      const sent = [
        await other.api.send({ id: newId(), room: room.id, text: "one" }),
        await other.api.send({ id: newId(), room: room.id, text: "two" }),
      ];
      for (const m of sent) handlers[0]!("create", m); // both in one tick: one batch, however slow the sends were
      await vi.waitFor(() => expect(calls).toEqual([[room.id, sent[1]!.created]]), { timeout: 3000 });
    });

    it("leaving sends a pending read right away", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const calls = reads(me.api);
      await mount(room);
      view!.unmount();
      view = undefined;
      expect(calls).toEqual([[room.id, m!.created]]);
    });

    it("away from the live edge nothing is marked; leaving asks the server for the real count", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const calls = reads(me.api);
      const ctl = instrument(me.api);
      await mount(room, { msgId: all[150]!.id });
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
      const before = ctl.calls("unreadCounts");
      view!.unmount();
      view = undefined;
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(before + 1));
    });

    it("a hidden tab doesn't mark anything until it is shown again", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const calls = reads(me.api);
      setVisibility("hidden");
      await mount(room);
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
      setVisibility("visible");
      await vi.waitFor(() => expect(calls).toEqual([[room.id, m!.created]]), { timeout: 3000 });
    });

    it("QA: scrolled up, a new message stays unread until you scroll down to it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      const old = await seedMessages(room.id, other.user.id, 30);
      const calls = reads(me.api);
      const handlers = captureHandler(me.api);
      await mount(room);
      await vi.waitFor(() => expect(calls).toEqual([[room.id, old[29]!.created]]), { timeout: 3000 });
      layout.scrollTo(0);
      const m = await other.api.send({ id: newId(), room: room.id, text: "unseen" });
      handlers[0]!("create", m);
      expect(pill().hidden).toBe(false);
      await sleep(READ_WINDOW_MS);
      expect(calls).toHaveLength(1);
      layout.scrollToBottom();
      await vi.waitFor(() => expect(calls.at(-1)).toEqual([room.id, m.created]), { timeout: 3000 });
    });

    it("QA: a failed read is sent again on the next render", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1);
      const ctl = instrument(me.api);
      ctl.failNext("markRead", new ApiError("Failed to fetch", 0));
      const calls = reads(me.api); // outside the failure, so the failed call is recorded too
      await mount(room);
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 3000 });
      ctl.reconnect(); // the gap fill renders
      await vi.waitFor(
        () =>
          expect(calls).toEqual([
            [room.id, m!.created],
            [room.id, m!.created],
          ]),
        { timeout: 3000 },
      );
    });
  });

  describe("QA fixes", () => {
    const editBox = (id: string) => msgEl(id)?.querySelector<HTMLTextAreaElement>("textarea.edit-input") ?? null;

    it("BUG-04: a failed room load shows an error with Retry instead of loading forever", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "here all along" });
      instrument(me.api).failNext("getRoom", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(list().textContent).toContain("Couldn't load this room.");
      expect(beginning()).toBeNull();
      expect(composer()).toBeNull(); // no writing into history you can't see
      button(list(), "Retry")!.click();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("here all along"));
      expect(list().textContent).not.toContain("Couldn't load");
      expect(composer()).not.toBeNull();
    });

    it("BUG-04: a failed load retries by itself when the connection comes back", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "back online" });
      const ctl = instrument(me.api);
      ctl.failNext("getRoom", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(list().textContent).toContain("Couldn't load this room.");
      ctl.reconnect();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("back online"));
    });

    it("BUG-05: a failed history load is not shown as an empty room", async () => {
      const room = await newRoom();
      await me.api.send({ id: newId(), room: room.id, text: "history" });
      instrument(me.api).failNext("page", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(beginning()).toBeNull();
      expect(list().textContent).toContain("Couldn't load this room.");
    });

    it("BUG-09: an open edit box closes when the message is deleted elsewhere", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "editing" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(editBox(m.id)).not.toBeNull();
      await me.api.softDelete(m.id); // e.g. from another tab
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("Message deleted"));
      expect(editBox(m.id)).toBeNull();
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't save");
      expect(ctl.calls("edit")).toBe(0);
    });

    it("BUG-16: saving an empty edit explains why nothing happens", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "keep" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "   ";
      key(editBox(m.id)!, "Enter");
      expect(msgEl(m.id)!.querySelector(".hint")!.textContent).toBe("A message can't be empty. Use Delete to remove it.");
      expect(editBox(m.id)).not.toBeNull();
      expect(ctl.calls("edit")).toBe(0);
    });

    it("BUG-13/14: lengths count characters like the server, and the counter matches the Send button", async () => {
      const room = await newRoom();
      await mount(room);
      type("😀".repeat(1500)); // 3000 UTF-16 units, 1500 characters: the server accepts it
      expect(sendButton().disabled).toBe(false);
      type(`${"x".repeat(2000)}   `); // trailing spaces are trimmed before sending
      expect(sendButton().disabled).toBe(false);
      expect(root.querySelector(".counter")!.textContent).toBe("0 left");
      type("x".repeat(2001));
      expect(sendButton().disabled).toBe(true);
      expect(root.querySelector(".counter")!.textContent).toBe("1 over");
    });

    it("BUG-18: a link to a message that isn't in this room says so", async () => {
      const room = await newRoom();
      const elsewhere = await newRoom();
      const m = await me.api.send({ id: newId(), room: elsewhere.id, text: "elsewhere" });
      await mount(room, { msgId: m.id });
      expect(root.querySelector(".room-notice")!.textContent).toContain("isn't in this room");
    });

    it("BUG-43: an open edit box keeps what you typed, its focus and caret when its message is redrawn", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const quoted = await other.api.send({ id: newId(), room: room.id, text: "v1" });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "my reply", replyTo: quoted.id });
      await mount(room);
      button(msgEl(reply.id), "Edit")!.click();
      const box = editBox(reply.id)!;
      box.value = "my reply, edited";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.setSelectionRange(3, 3);
      await other.api.edit(quoted.id, "v2"); // the reply's quote changes: its element is rebuilt
      await vi.waitFor(() => expect(msgEl(reply.id)!.querySelector(".reply-text")!.textContent).toBe("v2"));
      expect(editBox(reply.id)).not.toBe(box);
      expect(editBox(reply.id)!.value).toBe("my reply, edited");
      expect(document.activeElement).toBe(editBox(reply.id));
      expect(editBox(reply.id)!.selectionStart).toBe(3);
      // Escape forgets the typing: the next edit starts from the message again.
      key(editBox(reply.id)!, "Escape");
      button(msgEl(reply.id), "Edit")!.click();
      expect(editBox(reply.id)!.value).toBe("my reply");
    });

    it("BUG-50: what you were typing is still there when you come back from another room", async () => {
      const a = await newRoom();
      const b = await newRoom();
      const ctx = viewContext(me.api, store, navigate);
      const open = async (room: Room) => {
        view?.unmount();
        view = createRoomView(ctx);
        view.mount(root, { id: room.id });
        fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
        await loaded();
      };
      await open(a);
      type("half a thought");
      await open(b);
      expect(composer()!.value).toBe("");
      await open(a);
      expect(composer()!.value).toBe("half a thought");
      expect(sendButton().disabled).toBe(false);
      send("half a thought, finished");
      await open(b);
      await open(a);
      expect(composer()!.value).toBe(""); // sent: nothing left to keep
    });
  });

  describe("room header menu (§7.1)", () => {
    it("Hide / Unhide room", async () => {
      const room = await newRoom();
      await mount(room);
      button(headerMenu(), "Hide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(room.id)).toBe(true));
      button(headerMenu(), "Unhide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(room.id)).toBe(false));
    });

    it("Archive room asks for confirmation and is only offered to the creator", async () => {
      const room = await newRoom();
      await mount(room);
      button(headerMenu(), "Archive room")!.click();
      expect(headerMenu().textContent).toContain("read-only for everyone");
      button(headerMenu(), "Archive")!.click();
      await vi.waitFor(() => expect(composer()).toBeNull());
      button(headerMenu(), "Unarchive room")!.click();
      await vi.waitFor(() => expect(composer()).not.toBeNull());

      view!.unmount();
      const other = await signedUp("Other");
      const theirs = await newRoom(other);
      await mount(theirs);
      expect(button(headerMenu(), "Archive room")).toBeNull();
      expect(button(headerMenu(), "Hide room")).not.toBeNull();
    });

    it("BUG-17: a hidden room that was archived can still be unhidden", async () => {
      const other = await signedUp("Other");
      const theirs = await newRoom(other);
      await me.api.hideRoom(theirs.id);
      await other.api.setArchived(theirs.id, true);
      await mount(theirs);
      await vi.waitFor(() => expect(store.get().hidden.has(theirs.id)).toBe(true));
      expect(button(headerMenu(), "Hide room")).toBeNull();
      button(headerMenu(), "Unhide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(theirs.id)).toBe(false));
    });
  });

  describe("BUG-31: the list stays at the bottom when it gets shorter", () => {
    let resized: (() => void)[] = [];
    beforeEach(() => {
      resized = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            resized.push(cb);
          }
          observe() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("at the bottom: a shorter list (tray opened, textarea grew) scrolls to stay at the bottom", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 40);
      await mount(room);
      expect(atBottom()).toBe(true);
      layout.setClientHeight(VIEWPORT - 120);
      for (const cb of resized) cb();
      expect(list().scrollTop).toBe(list().scrollHeight - (VIEWPORT - 120));
    });

    it("scrolled up into history: the position is left alone", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 40);
      await mount(room);
      layout.scrollTo(100);
      layout.setClientHeight(VIEWPORT - 120);
      for (const cb of resized) cb();
      expect(list().scrollTop).toBe(100);
    });
  });

  describe("attachments (§17.4, §17.5)", () => {
    const pdf = (name = "doc.pdf") => new File(["%PDF"], name, { type: "application/pdf" });
    const tiles = (id: string) => [...msgEl(id)!.querySelectorAll<HTMLElement>(".att-tile")];
    const chips = (id: string) => [...msgEl(id)!.querySelectorAll<HTMLAnchorElement>("a.att-file")];
    let revoked: string[];

    beforeEach(() => {
      let n = 0;
      revoked = [];
      vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:local-${++n}`);
      vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    });

    function paste(files: File[]) {
      const e = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "clipboardData", { value: { files } });
      composer()!.dispatchEvent(e);
    }

    it("a pending message shows local previews; the server version replaces them and the previews are released", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      paste([pngFile("a.png"), pdf()]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(2));
      key(composer()!, "Enter");
      const pending = msgEls().at(-1)!;
      expect(pending.classList.contains("pending")).toBe(true);
      const preview = pending.querySelector<HTMLImageElement>(".att-tile img")!;
      expect(preview.getAttribute("src")).toBe("blob:local-1");
      expect(pending.querySelector(".att-file")!.textContent).toBe("doc.pdf");
      Object.defineProperties(preview, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
      preview.dispatchEvent(new Event("load"));
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      const img = msgEl(id)!.querySelector<HTMLImageElement>(".att-tile img")!;
      expect(img.getAttribute("src")).toMatch(/thumb=800x480f/);
      expect(img.getAttribute("src")).toMatch(/token=/);
      // Takes the preview's shape before it loads, so the tile doesn't narrow and widen again.
      expect(img.style.aspectRatio).toBe("600 / 300");
      expect(chips(id).map((a) => a.textContent)).toEqual(["doc.pdf"]);
      expect(revoked).toEqual(["blob:local-1"]);
    });

    it("an image the server shows as a file is a file while sending too", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      paste([new File(["BM"], "scan.bmp", { type: "image/bmp" }), pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(2));
      key(composer()!, "Enter");
      const pending = msgEls().at(-1)!;
      expect(pending.querySelector(".att-images")!.classList.contains("one")).toBe(true);
      expect(pending.querySelector(".att-file")!.textContent).toBe("scan.bmp");
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      expect(tiles(id)).toHaveLength(1);
      expect(chips(id).map((a) => a.textContent)).toEqual(["scan.bmp"]);
    });

    it("a failed send keeps its files; Retry sends the same id with the same files", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("offline", 0));
      // Outside the failure injection, so the failed attempt is recorded too.
      const calls: { id: string; files?: File[] }[] = [];
      intercept(me.api, "send", (original) => (m) => {
        calls.push({ id: m.id, ...(m.files ? { files: m.files } : {}) });
        return original(m);
      });
      await mount(room);
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      await vi.waitFor(() => expect(root.querySelector("li.msg.failed")).not.toBeNull());
      const id = root.querySelector<HTMLElement>("li.msg.failed")!.dataset.id!;
      expect(tiles(id)).toHaveLength(1);
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("failed")).toBe(false));
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      expect(calls.map((c) => c.id)).toEqual([id, id]);
      expect(calls[1]!.files![0]).toBe(calls[0]!.files![0]);
      expect((await me.api.getMessage(id)).files).toHaveLength(1);
    });

    it("discarding a failed send with files releases its previews", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("offline", 0));
      await mount(room);
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      await vi.waitFor(() => expect(root.querySelector("li.msg.failed")).not.toBeNull());
      button(root.querySelector("li.msg.failed"), "Discard")!.click();
      expect(revoked).toEqual(["blob:local-1"]);
    });

    it("unmount releases the previews of messages still sending", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      ctl.hold("send");
      paste([pngFile("a.png")]);
      await vi.waitFor(() => expect(root.querySelectorAll(".tray-item")).toHaveLength(1));
      key(composer()!, "Enter");
      view!.unmount();
      view = undefined;
      expect(revoked).toEqual(["blob:local-1"]);
    });

    it("one image is a large tile; several are a row of small ones; other files are download chips", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const one = await other.api.send({ id: newId(), room: room.id, text: "one", files: [pngFile("solo.png")] });
      const many = await other.api.send({
        id: newId(),
        room: room.id,
        text: "",
        files: [pngFile("a.png"), pngFile("b.png"), pngFile("c.png"), pdf("report.pdf")],
      });
      await mount(room);
      const [solo] = tiles(one.id);
      expect(solo!.closest(".att-images")!.classList.contains("one")).toBe(true);
      const big = solo!.querySelector("img")!;
      // Uncropped thumbs of any aspect ratio: CSS fixes the height, the image's own ratio sets the width.
      expect([big.hasAttribute("width"), big.hasAttribute("height"), big.getAttribute("loading")]).toEqual([false, false, "lazy"]);
      expect(big.getAttribute("src")).toMatch(/thumb=800x480f/);
      expect(big.getAttribute("alt")).toBe("solo.png");
      expect(solo!.getAttribute("target")).toBe("_blank");

      const grid = tiles(many.id);
      expect(grid).toHaveLength(3);
      expect(grid[0]!.closest(".att-images")!.classList.contains("row")).toBe(true);
      expect(grid.map((t) => t.querySelector("img")!.getAttribute("src"))).toEqual(Array(3).fill(expect.stringMatching(/thumb=480x240f/)));
      const [chip] = chips(many.id);
      expect(chip!.textContent).toBe("report.pdf");
      expect(chip!.getAttribute("download")).toBe("report.pdf");
      expect(chip!.getAttribute("href")).toMatch(/token=/);
    });

    it("BUG-28: files show, download and describe themselves under their original names", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({
        id: newId(),
        room: room.id,
        text: "",
        files: [pngFile("Beach Day!.png"), pdf("Quarterly Report (final).pdf")],
      });
      await mount(room);
      expect(tiles(m.id)[0]!.querySelector("img")!.getAttribute("alt")).toBe("Beach Day!.png");
      const [chip] = chips(m.id);
      expect(chip!.textContent).toBe("Quarterly Report (final).pdf");
      expect(chip!.getAttribute("download")).toBe("Quarterly Report (final).pdf");
    });

    it("a deleted message shows no attachments; editing keeps them visible", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "pic", files: [pngFile()] });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(tiles(m.id)).toHaveLength(1);
      key(root.querySelector("textarea.edit-input")!, "Escape");
      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      await vi.waitFor(() => expect(msgEl(m.id)!.classList.contains("deleted")).toBe(true));
      expect(tiles(m.id)).toHaveLength(0);
    });

    it("an image that fails to load retries once with a new token, then offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "", files: [pngFile()] });
      const ctl = instrument(me.api);
      await mount(room);
      const before = ctl.calls("fileToken");
      const img = () => msgEl(m.id)!.querySelector<HTMLImageElement>(".att-tile img");
      img()!.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(ctl.calls("fileToken")).toBe(before + 1));
      img()!.dispatchEvent(new Event("error"));
      expect(img()).toBeNull();
      const broken = msgEl(m.id)!.querySelector(".att-broken")!;
      expect(broken.textContent).toContain("Couldn't load image");
      button(broken, "Retry")!.click();
      expect(img()).not.toBeNull();
    });
  });

  describe("replies (§19)", () => {
    const replyBar = () => root.querySelector<HTMLElement>("form.composer .replying")!;
    const quoteOf = (id: string) => msgEl(id)?.querySelector<HTMLButtonElement>("button.reply-quote") ?? null;

    it("Reply shows who you're answering above the composer; the sent message quotes it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "lunch\nanyone?" });
      await mount(room);
      expect(replyBar().hidden).toBe(true);
      button(msgEl(parent.id), "Reply")!.click();
      expect(replyBar().hidden).toBe(false);
      expect(replyBar().textContent).toContain("Replying to Other");
      expect(replyBar().textContent).toContain("lunch anyone?");
      expect(document.activeElement).toBe(composer());
      send("yes!");
      expect(replyBar().hidden).toBe(true);
      const mine = msgEls().at(-1)!;
      expect(mine.querySelector(".reply-quote .reply-author")!.textContent).toBe("Other");
      expect(mine.querySelector(".reply-quote .reply-text")!.textContent).toBe("lunch anyone?");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      const saved = await me.api.getMessage(msgEls().at(-1)!.dataset.id!);
      expect(saved.reply_to).toBe(parent.id);
    });

    it("× or Escape cancels the reply; the next message is a plain one", async () => {
      const room = await newRoom();
      const parent = await me.api.send({ id: newId(), room: room.id, text: "first" });
      await mount(room);
      button(msgEl(parent.id), "Reply")!.click();
      button(replyBar(), "×")!.click();
      expect(replyBar().hidden).toBe(true);
      button(msgEl(parent.id), "Reply")!.click();
      key(composer()!, "Escape");
      expect(replyBar().hidden).toBe(true);
      send("plain");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      const id = msgEls().at(-1)!.dataset.id!;
      expect(quoteOf(id)).toBeNull();
      expect((await me.api.getMessage(id)).reply_to).toBe("");
    });

    it("clicking a quote highlights the original, loading the history around it when it isn't on screen", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const near = await me.api.send({ id: newId(), room: room.id, text: "re: last", replyTo: all[299]!.id });
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      await mount(room);
      quoteOf(near.id)!.click();
      expect(msgEl(all[299]!.id)!.classList.contains("target")).toBe(true);
      expect(ids()).not.toContain(all[10]!.id);
      quoteOf(far.id)!.click();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      expect(msgEl(all[299]!.id)).toBeNull();
      expect(sentinel("bottom")).not.toBeNull();
    });

    it("the highlight goes away after a few seconds; clicking the quote again shows it again", async () => {
      const room = await newRoom();
      const parent = await me.api.send({ id: newId(), room: room.id, text: "parent" });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      const target = () => msgEl(parent.id)!.classList.contains("target");
      quoteOf(reply.id)!.click();
      expect(target()).toBe(true);
      await sleep(HIGHLIGHT_MS - 500);
      expect(target()).toBe(true);
      await vi.waitFor(() => expect(target()).toBe(false), { timeout: 1500 });
      quoteOf(reply.id)!.click();
      expect(target()).toBe(true);
    });

    it("a quote follows edits and deletes of the original; a deleted original ends the reply being written", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "draft" });
      const reply = await other.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      expect(quoteOf(reply.id)!.textContent).toBe("Otherdraft");
      button(msgEl(parent.id), "Reply")!.click();
      await other.api.edit(parent.id, "final");
      await vi.waitFor(() => expect(quoteOf(reply.id)!.textContent).toBe("Otherfinal"));
      await vi.waitFor(() => expect(replyBar().textContent).toContain("final"));
      await other.api.softDelete(parent.id);
      await vi.waitFor(() => expect(quoteOf(reply.id)!.textContent).toBe("OtherMessage deleted"));
      expect(replyBar().hidden).toBe(true);
      expect(button(msgEl(parent.id), "Reply")).toBeNull();
    });

    it("no Reply in an archived room, on a deleted message, or on one still sending", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "y" });
      await me.api.softDelete(gone.id);
      const ctl = instrument(me.api);
      const release = ctl.hold("send");
      await mount(room);
      expect(button(msgEl(m.id), "Reply")).not.toBeNull();
      expect(button(msgEl(gone.id), "Reply")).toBeNull();
      send("pending");
      expect(button(msgEls().at(-1)!, "Reply")).toBeNull();
      release();
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(button(msgEl(m.id), "Reply")).toBeNull());
    });

    it("archiving the room ends the reply being written; it doesn't come back when the room is unarchived", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      button(msgEl(m.id), "Reply")!.click();
      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(composer()).toBeNull());
      await me.api.setArchived(room.id, false);
      await vi.waitFor(() => expect(composer()).not.toBeNull());
      expect(replyBar().hidden).toBe(true);
    });

    it("Escape while an input method is composing doesn't cancel the reply", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      button(msgEl(m.id), "Reply")!.click();
      key(composer()!, "Escape", { isComposing: true });
      expect(replyBar().hidden).toBe(false);
    });

    it("a message sent while a quote loads history isn't put after the old messages; it is there at the latest", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      const ctl = instrument(me.api);
      await mount(room);
      const releaseLoad = ctl.hold("getMessage");
      const releaseSend = ctl.hold("send");
      quoteOf(far.id)!.click();
      send("sent meanwhile");
      const id = msgEls().at(-1)!.dataset.id!;
      releaseLoad();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      releaseSend();
      await other.api.send({ id: newId(), room: room.id, text: "after" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      expect(ids()).not.toContain(id);
      pill().click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("pending")).toBe(false));
      expect(bodyOf(id)).toBe("sent meanwhile");
    });

    it("a failed message survives going back in history through a quote, and is there again at the latest", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      const ctl = instrument(me.api);
      await mount(room);
      ctl.failNext("send", new ApiError("offline", 0));
      send("will fail");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const id = msgEls().at(-1)!.dataset.id!;
      quoteOf(far.id)!.click();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      expect(msgEl(id)).toBeNull();
      await other.api.send({ id: newId(), room: room.id, text: "after" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      pill().click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("failed")).toBe(true));
      expect(ids().indexOf(id)).toBe(ids().length - 2); // before the newer "after"
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => expect(msgEl(id)?.matches(".pending, .failed")).toBe(false));
      expect((await me.api.getMessage(id)).text).toBe("will fail");
    });

    it("a reply to a message deleted unseen says why it wasn't sent, and can be sent without the quote", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "parent" });
      const gate = gateRealtime(me.api);
      await mount(room);
      button(msgEl(parent.id), "Reply")!.click();
      gate.offline = true; // the delete is never seen
      await other.api.softDelete(parent.id);
      await vi.waitFor(() => expect(gate.dropped).toBeGreaterThan(0));
      send("answer");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const el = msgEls().at(-1)!;
      const id = el.dataset.id!;
      expect(el.querySelector(".send-error")!.textContent).toContain("the message you replied to was deleted");
      expect(quoteOf(id)!.textContent).toContain("Message deleted");
      button(el, "Send without quote")!.click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("failed")).toBe(false));
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("pending")).toBe(false));
      expect(quoteOf(id)).toBeNull();
      const saved = await me.api.getMessage(id);
      expect([saved.text, saved.reply_to]).toEqual(["answer", ""]);
    });

    it("a quote's accessible name is short and isn't taken for the Reply button", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: `long ${"word ".repeat(300)}` });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      const label = quoteOf(reply.id)!.getAttribute("aria-label")!;
      expect(label.startsWith("Quoting Other: long word")).toBe(true);
      expect(label.length).toBeLessThan(140);
      expect(label).toContain("…. Show the original message.");
    });
  });

  describe("direct messages (§16.5)", () => {
    const menuLabels = () => [...headerMenu().querySelectorAll(".menu-items button")].map((b) => b.textContent);

    it("a DM is titled after the other member, with their avatar; the composer and beginning say who", async () => {
      const bob = await signedUp("Bob Builder");
      const dm = await me.api.openDm(bob.user.id);
      await mount(dm);
      const h1 = root.querySelector("header.room-header h1")!;
      expect(h1.querySelector("span:not(.avatar)")!.textContent).toBe("Bob Builder");
      expect(h1.querySelector(".avatar")!.textContent).toBe("BB");
      expect(composer()!.placeholder).toBe("Message Bob Builder");
      expect(beginning()!.textContent).toBe("Beginning of your conversation with Bob Builder");
    });

    it("its menu offers Close conversation and Jump to beginning, never Archive; closing goes home", async () => {
      const bob = await signedUp("Bob");
      const dm = await me.api.openDm(bob.user.id);
      await mount(dm);
      expect(menuLabels()).toEqual(["Close conversation", "Jump to beginning"]);
      button(headerMenu(), "Close conversation")!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("#/"));
      expect(store.get().hidden.has(dm.id)).toBe(true);
    });

    it("a closed DM opened by URL can be reopened", async () => {
      const bob = await signedUp("Bob");
      const dm = await me.api.openDm(bob.user.id);
      await me.api.hideRoom(dm.id);
      await mount(dm);
      await vi.waitFor(() => expect(menuLabels()[0]).toBe("Reopen conversation"));
      button(headerMenu(), "Reopen conversation")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(dm.id)).toBe(false));
    });

    it("someone else's DM is not found", async () => {
      const bob = await signedUp("Bob");
      const cat = await signedUp("Cat");
      const theirs = await bob.api.openDm(cat.user.id);
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: theirs.id });
      await vi.waitFor(() => expect(root.textContent).toContain("This room doesn't exist."));
    });

    it("another author's name opens a menu with Message, which opens the DM; your own name has none", async () => {
      const bob = await signedUp("Bob");
      const room = await newRoom();
      await bob.api.send({ id: newId(), room: room.id, text: "hi from bob" });
      await me.api.send({ id: newId(), room: room.id, text: "hi from me" });
      await mount(room);
      const [theirs, mine] = msgEls();
      expect(mine!.querySelector("details.author-menu")).toBeNull();
      const authorMenu = theirs!.querySelector<HTMLDetailsElement>("details.author-menu")!;
      expect(authorMenu.querySelector("summary.author")!.textContent).toBe("Bob");
      authorMenu.open = true;
      button(authorMenu, "Message")!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^#\/r\//)));
      const dmId = navigate.mock.calls.at(-1)![0].slice(4);
      expect(store.get().rooms.get(dmId)?.members).toContain(bob.user.id);
    });
  });

  describe("avatars (§15.4)", () => {
    const avatarOf = (el: Element) => el.querySelector(".avatar");

    it("each author group starts with the author's avatar (or initials); continuations have none", async () => {
      const other = await signedUp("Other Person");
      const pic = await other.api.setAvatar(pngFile());
      const room = await newRoom();
      await other.api.send({ id: newId(), room: room.id, text: "one" });
      await other.api.send({ id: newId(), room: room.id, text: "two" });
      await me.api.send({ id: newId(), room: room.id, text: "three" });
      await mount(room);
      const [first, second, third] = msgEls();
      const img = avatarOf(first!) as HTMLImageElement;
      expect(img.tagName).toBe("IMG");
      expect(img.getAttribute("src")).toContain(pic.avatar);
      expect(avatarOf(second!)).toBeNull();
      expect(avatarOf(third!)!.textContent).toBe("M");
    });

    it("a message whose author's avatar changed is re-rendered", async () => {
      const room = await newRoom();
      const handlers = captureHandler(me.api);
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await mount(room);
      expect(avatarOf(msgEl(m.id)!)!.tagName).toBe("SPAN");
      handlers[0]!("update", {
        ...m,
        updated: "2999-01-01 00:00:00.000Z",
        expand: { author: { ...me.user, avatar: "new_abcdefghij.png" } },
      });
      await vi.waitFor(() => expect(avatarOf(msgEl(m.id)!)!.getAttribute("src")).toContain("new_abcdefghij.png"));
    });
  });
  describe("reactions and the emoji picker (§20)", () => {
    const picker = () => root.querySelector<HTMLElement>(".emoji-picker")!;
    const pickerOpen = () => !picker().hidden;
    const pick = (emoji: string) => picker().querySelector<HTMLButtonElement>(`button.emoji[data-emoji="${emoji}"]`)!.click();
    const chips = (id: string) =>
      [...(msgEl(id)?.querySelectorAll<HTMLElement>(".reactions .reaction") ?? [])].map((c) => {
        const pressed = c.getAttribute("aria-pressed");
        return `${c.textContent}${pressed === "true" ? " (mine)" : ""}`;
      });
    const chip = (id: string, emoji: string) => msgEl(id)!.querySelector<HTMLElement>(`.reactions .reaction[data-emoji="${emoji}"]`)!;
    const serverReactions = async (id: string) => (await me.api.getMessage(id)).reactions;

    it("React opens the picker; picking adds my reaction at once, and it is saved", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "ship it" });
      await mount(room);
      const react = button(msgEl(m.id), "React")!;
      expect(react.getAttribute("aria-label")).toBe("Add reaction");
      expect(pickerOpen()).toBe(false);
      react.click();
      expect(pickerOpen()).toBe(true);
      expect(picker().getAttribute("aria-label")).toBe("Add reaction");
      pick("🚀");
      expect(pickerOpen()).toBe(false);
      expect(chips(m.id)).toEqual(["🚀1 (mine)"]);
      expect(chip(m.id, "🚀").getAttribute("aria-label")).toBe("🚀 1 reaction");
      expect(chip(m.id, "🚀").title).toBe("You reacted with 🚀");
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([{ emoji: "🚀", users: [me.user.id] }]));
    });

    it("any number of different reactions; a chip adds mine or takes it back", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "news" });
      await other.api.react(m.id, "🎉", true);
      await mount(room);
      expect(chips(m.id)).toEqual(["🎉1"]);
      expect(chip(m.id, "🎉").title).toBe("Other reacted with 🎉");
      chip(m.id, "🎉").click();
      expect(chips(m.id)).toEqual(["🎉2 (mine)"]);
      for (const e of ["👍", "❤️", "😂"]) {
        button(msgEl(m.id), "☺+")!.click();
        pick(e);
      }
      expect(chips(m.id)).toEqual(["🎉2 (mine)", "👍1 (mine)", "❤️1 (mine)", "😂1 (mine)"]);
      await vi.waitFor(async () => expect((await serverReactions(m.id))?.length).toBe(4));
      chip(m.id, "🎉").click();
      chip(m.id, "👍").click();
      expect(chips(m.id)).toEqual(["🎉1", "❤️1 (mine)", "😂1 (mine)"]);
      expect(chip(m.id, "🎉").title).toBe("Other reacted with 🎉");
      await vi.waitFor(async () =>
        expect(await serverReactions(m.id)).toEqual([
          { emoji: "🎉", users: [other.user.id] },
          { emoji: "❤️", users: [me.user.id] },
          { emoji: "😂", users: [me.user.id] },
        ]),
      );
    });

    it("other people's reactions show live", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hello" });
      await mount(room);
      expect(msgEl(m.id)!.querySelector(".reactions")).toBeNull();
      await other.api.react(m.id, "👋", true);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1"]));
      // Other hasn't written here: their name is looked up.
      await vi.waitFor(() => expect(chip(m.id, "👋").title).toBe("Other reacted with 👋"));
      await other.api.react(m.id, "👋", false);
      await vi.waitFor(() => expect(msgEl(m.id)!.querySelector(".reactions")).toBeNull());
    });

    it("focus on a reaction or a message's button stays when someone else's reaction redraws the message", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hello" });
      await other.api.react(m.id, "👋", true);
      await mount(room);
      chip(m.id, "👋").focus();
      await other.api.react(m.id, "🎉", true);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1", "🎉1"]));
      expect(document.activeElement).toBe(chip(m.id, "👋"));
      button(msgEl(m.id), "Reply")!.focus();
      await other.api.react(m.id, "🎉", false);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1"]));
      expect(document.activeElement).toBe(button(msgEl(m.id), "Reply"));
    });

    it("picking an emoji I already reacted with takes it back", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await me.api.react(m.id, "👍", true);
      await mount(room);
      button(msgEl(m.id), "React")!.click();
      expect(picker().querySelector(`button.emoji[data-emoji="👍"]`)!.getAttribute("aria-pressed")).toBe("true");
      pick("👍");
      expect(chips(m.id)).toEqual([]);
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([]));
    });

    it("a failed reaction goes back to how it was and offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      const ctl = instrument(me.api);
      ctl.failNext("react", new ApiError("Failed to fetch", 0));
      await mount(room);
      button(msgEl(m.id), "React")!.click();
      pick("🔥");
      expect(chips(m.id)).toEqual(["🔥1 (mine)"]);
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't add your 🔥 reaction."));
      expect(chips(m.id)).toEqual([]);
      // The reaction it was on is gone: focus goes to React, not to the page.
      expect(document.activeElement).toBe(msgEl(m.id)!.querySelector(".actions .react"));
      button(msgEl(m.id), "Retry")!.click();
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["🔥1 (mine)"]));
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't");
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([{ emoji: "🔥", users: [me.user.id] }]));
      expect(chips(m.id)).toEqual(["🔥1 (mine)"]);
    });

    it("changed again before the server answered: what shows and what is saved is the last choice", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("react");
      button(msgEl(m.id), "React")!.click();
      pick("👍");
      await vi.waitFor(() => expect(ctl.calls("react")).toBe(1)); // on its way, unanswered
      chip(m.id, "👍").click(); // off
      expect(chips(m.id)).toEqual([]);
      button(msgEl(m.id), "React")!.click();
      pick("👍"); // on again
      chip(m.id, "👍").click(); // and off
      expect(chips(m.id)).toEqual([]);
      release();
      await vi.waitFor(() => expect(ctl.calls("react")).toBe(2)); // the first, then only the last (others superseded)
      await sleep(100);
      expect(chips(m.id)).toEqual([]);
      expect(await serverReactions(m.id)).toEqual([]);
    });

    it("keeps focus on the reaction it changed; Escape in the picker goes back to React", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await mount(room);
      button(msgEl(m.id), "React")!.click();
      key(document.activeElement!, "Escape");
      expect(pickerOpen()).toBe(false);
      expect(document.activeElement).toBe(button(msgEl(m.id), "React"));
      button(msgEl(m.id), "React")!.click();
      pick("👀");
      expect(document.activeElement).toBe(chip(m.id, "👀"));
      chip(m.id, "👀").click();
      expect(document.activeElement).toBe(button(msgEl(m.id), "React"));
    });

    it("no React on a message still sending, deleted, or in an archived room, where reactions only show", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "kept" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.react(m.id, "👍", true);
      await me.api.react(gone.id, "👍", true);
      const ctl = instrument(me.api);
      await mount(room);
      expect(chips(gone.id)).toEqual(["👍1 (mine)"]);
      await me.api.softDelete(gone.id);
      await vi.waitFor(() => expect(msgEl(gone.id)!.querySelector(".reactions")).toBeNull());
      expect(button(msgEl(gone.id), "React")).toBeNull();

      const release = ctl.hold("send");
      send("on its way");
      expect(button(msgEls().at(-1)!, "React")).toBeNull();
      release();

      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(button(msgEl(m.id), "React")).toBeNull());
      expect(chip(m.id, "👍").tagName).toBe("SPAN");
      expect(chips(m.id)).toEqual(["👍1"]);
      expect(button(msgEl(m.id), "☺+")).toBeNull();
    });

    it("the composer's emoji button inserts at the caret, replacing a selection", async () => {
      const room = await newRoom();
      await mount(room);
      type("hello world");
      composer()!.setSelectionRange(6, 11); // "world"
      const emoji = root.querySelector<HTMLButtonElement>("form.composer .emoji-button")!;
      expect(emoji.getAttribute("aria-label")).toBe("Emoji");
      emoji.click();
      expect(picker().getAttribute("aria-label")).toBe("Insert emoji");
      pick("🌎");
      expect(composer()!.value).toBe("hello 🌎");
      expect(document.activeElement).toBe(composer());
      expect(composer()!.selectionStart).toBe("hello 🌎".length);
      expect(sendButton().disabled).toBe(false);
      emoji.click();
      key(document.activeElement!, "Escape");
      expect(document.activeElement).toBe(composer());
      expect(composer()!.value).toBe("hello 🌎");
    });
  });

  describe("selecting, deleting and forwarding several messages (§21)", () => {
    const bar = () => root.querySelector<HTMLElement>(".selection-bar");
    const box = (id: string) => msgEl(id)?.querySelector<HTMLInputElement>("input.select") ?? null;
    const dialog = () => root.querySelector<HTMLDialogElement>("dialog.forward")!;
    const targetEls = () => [...dialog().querySelectorAll<HTMLButtonElement>(".forward-list button")];
    const targets = () => targetEls().map((b) => b.lastElementChild!.textContent);
    const target = (label: string) => targetEls().find((b) => b.lastElementChild!.textContent === label)!;
    const select = (id: string) => button(msgEl(id), "Select")!.click();

    it("Select starts selecting: checkboxes on every message, a bar instead of the composer", async () => {
      const room = await newRoom();
      const [a, b] = await seedMessages(room.id, me.user.id, 2);
      await mount(room);
      expect(bar()).toBeNull();
      select(a!.id);
      expect(box(a!.id)!.checked).toBe(true);
      expect(box(b!.id)!.checked).toBe(false);
      expect(document.activeElement).toBe(box(a!.id));
      expect(composer()).toBeNull();
      expect(bar()!.textContent).toContain("1 selected");
      expect(msgEl(a!.id)!.querySelector(".actions")).toBeNull(); // no single-message actions meanwhile
      // A click anywhere on a message toggles it, as does its checkbox.
      msgEl(b!.id)!.querySelector<HTMLElement>(".body")!.click();
      expect(bar()!.textContent).toContain("2 selected");
      expect(msgEl(b!.id)!.classList.contains("selected")).toBe(true);
      box(a!.id)!.click();
      expect(bar()!.textContent).toContain("1 selected");
      // Unselecting the last one, Cancel or Escape stops selecting; the composer and its text come back.
      box(b!.id)!.click();
      expect(bar()).toBeNull();
      expect(box(a!.id)).toBeNull();
      type("draft");
      select(a!.id);
      key(box(a!.id)!, "Escape");
      expect(bar()).toBeNull();
      expect(composer()!.value).toBe("draft");
      expect(document.activeElement).toBe(composer());
      select(a!.id);
      button(bar(), "Cancel")!.click();
      expect(bar()).toBeNull();
    });

    it("deleted and unsent messages can't be selected; one deleted meanwhile is unselected", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.softDelete(gone.id);
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      await mount(room);
      expect(button(msgEl(gone.id), "Select")).toBeNull();
      select(theirs.id);
      expect(box(gone.id)).toBeNull();
      msgEl(mine.id)!.click();
      expect(bar()!.textContent).toContain("2 selected");
      await other.api.softDelete(theirs.id);
      await vi.waitFor(() => expect(bar()!.textContent).toContain("1 selected"));
      expect(box(theirs.id)).toBeNull();
    });

    it("at most 50 messages at a time", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 50);
      await mount(room);
      const extra = await me.api.send({ id: newId(), room: room.id, text: "one more" });
      await vi.waitFor(() => expect(msgEl(extra.id)).not.toBeNull());
      select(seeded[0]!.id);
      for (const m of seeded.slice(1)) box(m.id)!.click();
      expect(bar()!.textContent).toContain("50 selected");
      box(extra.id)!.click();
      expect(bar()!.textContent).toContain("50 selected");
      expect(box(extra.id)!.checked).toBe(false);
      expect(root.querySelector(".room-notice")!.textContent).toBe("You can select up to 50 messages at a time.");
      button(bar(), "Cancel")!.click();
      expect(root.querySelector(".room-notice")!.textContent).toBe("");
    });

    it("forwarding can't be cancelled halfway: a failure is always seen", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      const ctl = instrument(me.api);
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(room.id)).toBe(true));
      const release = ctl.hold("forward");
      ctl.failNext("forward", new ApiError("Failed to fetch", 0));
      button(msgEl(m.id), "Forward")!.click();
      target(`#${room.name}`).click();
      expect(button(dialog(), "Cancel")!.disabled).toBe(true);
      const cancel = new Event("cancel", { cancelable: true });
      dialog().dispatchEvent(cancel); // Escape
      expect(cancel.defaultPrevented).toBe(true);
      dialog().close(); // closed anyway (a browser lets a second Escape through)
      release();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward."));
      expect(dialog().open).toBe(true);
      expect(button(dialog(), "Cancel")!.disabled).toBe(false);
    });

    it("the dialog says it is searching for people, not that nothing was found, until it knows", async () => {
      const name = `Quinn ${uniq()}`;
      await signedUp(name);
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      button(msgEl(m.id), "Forward")!.click();
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      const status = () => dialog().querySelector(".search-status")!.textContent;
      search.value = name;
      search.dispatchEvent(new Event("input"));
      expect(status()).toBe("Searching…");
      await vi.waitFor(() => expect(targets()).toEqual([name]));
      expect(status()).toBe("");
      search.value = `nobody-${uniq()}`;
      search.dispatchEvent(new Event("input"));
      expect(status()).toBe("Searching…");
      await vi.waitFor(() => expect(status()).toBe("Nothing found."));
    });

    it("Delete is offered only when every selected message is mine; it asks, then deletes them all in one request", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m1 = await me.api.send({ id: newId(), room: room.id, text: "one" });
      const m2 = await me.api.send({ id: newId(), room: room.id, text: "two" });
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const ctl = instrument(me.api);
      await mount(room);
      select(m1.id);
      box(theirs.id)!.click();
      expect(button(bar(), "Delete")!.hidden).toBe(true);
      box(theirs.id)!.click();
      box(m2.id)!.click();
      expect(button(bar(), "Delete")!.hidden).toBe(false);
      button(bar(), "Delete")!.click();
      expect(bar()!.textContent).toContain("Delete these 2 messages?");
      expect(document.activeElement).toBe(button(bar(), "Cancel"));
      key(document.activeElement!, "Escape"); // back to the bar, still selecting
      expect(bar()!.textContent).toContain("2 selected");
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      expect(bar()).toBeNull();
      expect([bodyOf(m1.id), bodyOf(m2.id), bodyOf(theirs.id)]).toEqual(["Message deleted", "Message deleted", "theirs"]);
      await vi.waitFor(() => expect(ctl.calls("deleteMany")).toBe(1));
      expect(ctl.calls("softDelete")).toBe(0);
      await vi.waitFor(async () => expect((await other.api.getMessage(m2.id)).deleted).toBe(true));
    });

    it("a failed delete puts the messages back and says why (QA BUG-58: not always “Check your connection”)", async () => {
      const room = await newRoom();
      const m1 = await me.api.send({ id: newId(), room: room.id, text: "one" });
      const ctl = instrument(me.api);
      ctl.failNext("deleteMany", new ApiError("Failed to fetch", 0));
      ctl.failNext("deleteMany", new ApiError("Too Many Requests.", 429));
      await mount(room);
      const notice = () => root.querySelector(".room-notice")!.textContent;
      select(m1.id);
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      await vi.waitFor(() => expect(notice()).toBe("Couldn't delete those messages. Can't reach the server. Check your connection."));
      expect(bodyOf(m1.id)).toBe("one");
      select(m1.id);
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      await vi.waitFor(() => expect(notice()).toBe("Couldn't delete those messages. Too many attempts. Wait a few seconds and try again."));
      expect(bodyOf(m1.id)).toBe("one");
    });

    it("Forward offers your rooms and DMs; picking one forwards the selection there, in order, and goes there", async () => {
      const bob = await signedUp("Bob");
      const room = await newRoom();
      const elsewhere = await newRoom();
      const dm = await me.api.openDm(bob.user.id);
      const m1 = await bob.api.send({ id: newId(), room: room.id, text: "first" });
      const m2 = await me.api.send({ id: newId(), room: room.id, text: "second" });
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(elsewhere.id)).toBe(true));
      select(m2.id);
      box(m1.id)!.click();
      button(bar(), "Forward")!.click();
      expect(dialog().open).toBe(true);
      expect(dialog().querySelector("h2")!.textContent).toBe("Forward 2 messages");
      expect(targets()).toEqual(expect.arrayContaining(["Bob", `#${room.name}`, `#${elsewhere.name}`]));
      expect(targets()[0]).toBe("Bob"); // conversations first
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      expect(document.activeElement).toBe(search);
      search.value = elsewhere.name.slice(-6);
      search.dispatchEvent(new Event("input"));
      expect(targets()).toEqual([`#${elsewhere.name}`]);
      target(`#${elsewhere.name}`).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/r/${elsewhere.id}`));
      expect(dialog().open).toBe(false);
      const page = await me.api.page({ filter: "room = {:r}", params: { r: elsewhere.id }, sort: "created,id" });
      expect(page.map((m) => [m.text, m.author, m.expand?.forwarded_from?.name])).toEqual([
        ["first", me.user.id, "Bob"],
        ["second", me.user.id, "Me"],
      ]);
      void dm;
    });

    it("Forward on a single message; to someone you have no DM with yet, found by name", async () => {
      const name = `Zed ${uniq()}`;
      const zed = await signedUp(name);
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "psst" });
      await mount(room);
      button(msgEl(m.id), "Forward")!.click();
      expect(dialog().querySelector("h2")!.textContent).toBe("Forward message");
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      search.value = name;
      search.dispatchEvent(new Event("input"));
      await vi.waitFor(() => expect(targets()).toEqual([name]));
      target(name).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^#\/r\//)));
      const dmId = navigate.mock.calls.at(-1)![0].slice(4);
      expect(store.get().rooms.get(dmId)?.members).toContain(zed.user.id);
      const [copy] = await zed.api.page({ filter: "room = {:r}", params: { r: dmId }, sort: "created,id" });
      expect(copy).toMatchObject({ text: "psst", forwarded_from: me.user.id });
    });

    it("a forward that fails says why in the dialog and can be tried again; forwarding here stays here", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "again" });
      const ctl = instrument(me.api);
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(room.id)).toBe(true));
      ctl.failNext("forward", new ApiError("Failed to fetch", 0));
      button(msgEl(m.id), "Forward")!.click();
      target(`#${room.name}`).click();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward. Can't reach the server."));
      expect(dialog().open).toBe(true);
      target(`#${room.name}`).click();
      await vi.waitFor(() => expect(dialog().open).toBe(false));
      expect(navigate).not.toHaveBeenCalled();
      expect(root.querySelector(".room-notice")!.textContent).toBe("Message forwarded.");
      await vi.waitFor(() => expect(msgEls().at(-1)!.querySelector(".forwarded")?.textContent).toBe("Forwarded from Me"));
      // A confirmation, not a state: it goes away by itself (§22.6).
      await vi.waitFor(() => expect(root.querySelector(".room-notice")!.textContent).toBe(""), { timeout: NOTICE_MS + 2000 });
    });

    it("archived rooms: forwarding still works, deleting doesn't", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "kept" });
      await me.api.setArchived(room.id, true);
      await mount(room);
      expect(button(msgEl(m.id), "Forward")).not.toBeNull();
      select(m.id);
      expect(button(bar(), "Forward")).not.toBeNull();
      expect(button(bar(), "Delete")!.hidden).toBe(true);
      expect(root.querySelector(".archived-banner")).toBeNull();
      button(bar(), "Cancel")!.click();
      expect(root.querySelector(".archived-banner")).not.toBeNull();
    });
  });

  describe("§22: drafts across reloads, focus, Jump to latest", () => {
    it("what you typed survives a reload (a new app with the same storage), and is gone once sent (§22.3)", async () => {
      const room = await newRoom();
      await mount(room);
      type("unsent thought");
      view!.unmount();
      // A reload: nothing in memory survives, only localStorage.
      view = createRoomView({ ...viewContext(me.api, store, navigate), drafts: createDrafts(() => me.user.id) });
      view.mount(root, { id: room.id });
      fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
      await loaded();
      expect(composer()!.value).toBe("unsent thought");
      send("unsent thought");
      expect(createDrafts(() => me.user.id).get(room.id)).toBe("");
    });

    it("drafts are per user, and the session's end clears them", () => {
      const drafts = createDrafts(() => me.user.id);
      drafts.set("room1", "mine");
      expect(createDrafts(() => "someone-else").get("room1")).toBe("");
      expect(createDrafts(() => "").get("room1")).toBe(""); // logged out: nothing
      drafts.set("room2", "   ");
      expect(drafts.get("room2")).toBe(""); // blank is no draft
      drafts.clear(me.user.id);
      expect(drafts.get("room1")).toBe("");
    });

    it("entering a room puts the caret in the composer (§22.5)", async () => {
      const room = await newRoom();
      (document.activeElement as HTMLElement | null)?.blur();
      await mount(room);
      expect(document.activeElement).toBe(composer());
    });

    it("not on a touch screen, where it would pop up the keyboard", async () => {
      const room = await newRoom();
      vi.spyOn(window, "matchMedia").mockImplementation((q) => ({ matches: q === "(hover:none)" }) as MediaQueryList);
      (document.activeElement as HTMLElement | null)?.blur();
      await mount(room);
      expect(document.activeElement).not.toBe(composer());
    });

    it("scrolled up with nothing new, 'Jump to latest' takes you back to the bottom (§22.7)", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      expect(pill().hidden).toBe(true);
      layout.scrollTo(0);
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("↓ Jump to latest");
      expect(pill().classList.contains("jump")).toBe(true);
      pill().click();
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
      layout.scrollTo(0);
      layout.scrollToBottom(); // scrolling down yourself hides it too
      expect(pill().hidden).toBe(true);
    });

    it("back in history (e.g. after following a quote), it loads the latest page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await mount(room, { msgId: all[20]!.id });
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("↓ Jump to latest");
      pill().click();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(all.at(-1)!.id));
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });
  });
});
