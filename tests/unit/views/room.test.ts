import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Action, type Api } from "../../../web/src/api.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Message, Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { createStore, initialState, type AppState, type Store } from "../../../web/src/store.ts";
import { dayLabel, parsePb } from "../../../web/src/lib/time.ts";
import { createRoomView } from "../../../web/src/views/room.ts";
import { instrument, intercept, seedMessages, signedUp, uniq, viewContext, type SignedUp } from "../../support/api.ts";
import { fakeLayout, installIntersectionObserver } from "../../support/dom.ts";

const ROW = 40;
const VIEWPORT = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("room view (§7.5–7.6, TODO Phase 5)", () => {
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
  const texts = () => msgEls().map((el) => el.querySelector(".body")!.textContent);
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
  }

  /** Drop realtime message events while `offline` is true (to simulate a dropped connection). */
  function gateRealtime(api: Api) {
    const state = { offline: false };
    intercept(api, "subscribeMessages", (original) => (roomId, fn) =>
      original(roomId, (action, rec) => {
        if (!state.offline) fn(action, rec);
      }),
    );
    return state;
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

    it("live messages that arrive before the first page loads are not lost", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const ctl = instrument(me.api);
      const release = ctl.hold("page");
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: room.id });
      await vi.waitFor(() => expect(ctl.calls("subscribeMessages")).toBe(1));
      await sleep(200); // let the SSE subscription settle before the other user posts
      const early = await other.api.send({ id: newId(), room: room.id, text: "early bird" });
      await sleep(300);
      release();
      await loaded();
      await vi.waitFor(() => expect(ids()).toContain(early.id));
      expect(ids().filter((x) => x === early.id)).toHaveLength(1);
    });

    it("an unknown room shows a not-found message", async () => {
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: "doesnotexist123" });
      await vi.waitFor(() => expect(root.textContent).toContain("This room doesn't exist."));
      expect(composer()).toBeNull();
    });

    it("unmount unsubscribes and ignores events still in flight", async () => {
      const room = await newRoom();
      const handlers = captureHandler(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      view!.unmount();
      view = undefined;
      handlers[0]!("create", { id: newId(), room: room.id, author: "x", text: "late", created: "", updated: "", edited_at: "", deleted: false });
      expect(root.childNodes).toHaveLength(0);
      expect(ctl.calls("subscribeMessages")).toBe(1);
    });
  });

  // ---- 5.2 ----

  describe("composer and optimistic send (5.2)", () => {
    it("Enter sends; the message shows immediately as pending, then confirmed, never duplicated", async () => {
      const room = await newRoom();
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
      await sleep(300); // realtime echo of our own message
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

    it("scrolls back to the very first message of a long history, never holding more than 300", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 1000);
      await mount(room);
      let max = 0;
      let firstShown = ids()[0];
      for (let i = 0; i < 30 && !beginning(); i++) {
        expect(io.intersect(sentinel("top"))).toBe(true);
        // 1000 = 20 full pages, so the last older page is legitimately empty: then only the marker appears.
        await vi.waitFor(() => expect(ids()[0] !== firstShown || beginning() !== null).toBe(true));
        firstShown = ids()[0];
        max = Math.max(max, msgEls().length);
        contiguous(all);
      }
      expect(beginning()!.textContent).toBe(`Beginning of #${room.name}`);
      expect(ids()[0]).toBe(all[0]!.id);
      expect(max).toBeLessThanOrEqual(300);
      expect(sentinel("top")).toBeNull();
      expect(sentinel("bottom")).not.toBeNull();
    });

    it("scrolling back down returns to the live edge", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 450);
      await mount(room, { msgId: all[10]!.id });
      expect(sentinel("bottom")).not.toBeNull();
      for (let i = 0; i < 20 && sentinel("bottom"); i++) {
        const last = ids().at(-1);
        io.intersect(sentinel("bottom"));
        await vi.waitFor(() => expect(ids().at(-1)).not.toBe(last));
        expect(msgEls().length).toBeLessThanOrEqual(300);
        contiguous(all);
      }
      expect(sentinel("bottom")).toBeNull();
      expect(ids().at(-1)).toBe(all.at(-1)!.id);
    });

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

    it("only one older-page request runs at a time", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("page");
      io.intersect(sentinel("top"));
      io.intersect(sentinel("top"));
      await sleep(20);
      expect(ctl.calls("page")).toBe(2); // initial + one older
      release();
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
    });

    it("a page that arrives after a jump is discarded", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await mount(room);
      // From here on, each page response waits until released, in an order the test chooses.
      // Slots are assigned at call time, so gates[i] is the i-th request whatever order the server answers in.
      const gates: (() => void)[] = [];
      intercept(me.api, "page", (original) => async (q, signal) => {
        const gate = new Promise<void>((r) => gates.push(r));
        const res = await original(q, signal);
        await gate;
        return res;
      });
      io.intersect(sentinel("top")); // older page (will arrive late)
      button(headerMenu(), "Jump to beginning")!.click(); // first page
      await vi.waitFor(() => expect(gates).toHaveLength(2));
      gates[1]!(); // the jump's page arrives first…
      await vi.waitFor(() => expect(beginning()).not.toBeNull());
      gates[0]!(); // …then the stale older page
      await sleep(50);
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(sentinel("top")).toBeNull();
    });

    it("Jump to beginning during the initial load wins over the late first page, and the view still becomes ready", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      let releaseInitial!: () => void;
      const initialHeld = new Promise<void>((r) => (releaseInitial = r));
      let n = 0;
      intercept(me.api, "page", (original) => async (q, signal) => {
        const res = await original(q, signal);
        if (n++ === 0) await initialHeld; // only the initial latest-page load is slow
        return res;
      });
      view = createRoomView(viewContext(me.api, store, navigate));
      view.mount(root, { id: room.id });
      layout = fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
      await vi.waitFor(() => expect(n).toBe(1));
      button(headerMenu(), "Jump to beginning")!.click();
      await vi.waitFor(() => expect(ids()[0]).toBe(all[0]!.id));
      releaseInitial();
      await loaded();
      await sleep(50);
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(beginning()).not.toBeNull();
    });
  });

  // ---- 5.5 ----

  describe("reconnect gap fill (5.5)", () => {
    it("at the live edge, fetches everything missed while disconnected, in order", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 20);
      const gate = gateRealtime(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      gate.offline = true;
      const missed: Message[] = [];
      for (let i = 0; i < 80; i++) missed.push(await other.api.send({ id: newId(), room: room.id, text: `missed ${i}` }));
      await sleep(200);
      expect(ids()).not.toContain(missed[0]!.id);
      gate.offline = false;
      const pagesBefore = ctl.calls("page");
      ctl.reconnect();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(missed.at(-1)!.id));
      expect(ids().slice(-80)).toEqual(missed.map((m) => m.id));
      expect(ctl.calls("page") - pagesBefore).toBe(2); // 50 + 30
    });

    it("scrolled into history, a reconnect fetches no messages", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      const ctl = instrument(me.api);
      await mount(room, { msgId: all[10]!.id });
      const pages = ctl.calls("page");
      ctl.reconnect();
      await sleep(200);
      expect(ctl.calls("page")).toBe(pages);
    });

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
  });
});
