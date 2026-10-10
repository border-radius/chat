// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, archived mode.

import { ApiError, type Action, type Api } from "../api.ts";
import { clear, h, reconcile } from "../dom.ts";
import { PAGE_SIZE, first, latest, newer, older } from "../lib/cursor.ts";
import { newId } from "../lib/id.ts";
import {
  applyPage,
  emptyWindow,
  lastOwnEditable,
  merge,
  remove,
  startsGroup,
  trim,
  type MessageWindow,
  type PageKind,
} from "../lib/messages.ts";
import { captureAnchor, isNearBottom, restoreAnchor } from "../lib/scroll.ts";
import { dayLabel, formatFull, formatTime, parsePb, toPb } from "../lib/time.ts";
import type { Message, Room } from "../lib/types.ts";
import type { View } from "../router.ts";
import type { AppState, Store } from "../store.ts";

const MAX_LEN = 2000;
const COUNTER_FROM = 1800;

export interface RoomDeps {
  api: Api;
  store: Store<AppState>;
  navigate: (hash: string) => void;
}

interface MsgError {
  text: string;
  retry: () => void;
}

let uid = 0;

export function createRoomView({ api, store }: RoomDeps): View {
  const vid = `room-${++uid}`;
  let roomId = "";
  let targetId: string | null = null;
  let root: HTMLElement;
  let ac: AbortController;
  let active = false;

  // message window state
  let win: MessageWindow = emptyWindow();
  let gen = 0;
  let ready = false;
  let buffer: [Action, Message][] = [];
  let loadingOlder = false;
  let loadingNewer = false;
  let pillMode: "below" | "history" | null = null;

  // per-message UI state
  let editing: string | null = null;
  let focusEdit = false;
  let confirmDelete: string | null = null;
  const errors = new Map<string, MsgError>();
  const cache = new Map<string, { sig: string; el: HTMLElement }>();
  const dividers = new Map<string, HTMLElement>();

  // header UI state
  let menuOpen = false;
  let confirmArchive = false;
  /** Selector (within the room) to focus after the next render; the elements are rebuilt. */
  let focusAfter: string | null = null;
  const msgSel = (id: string) => `li.msg[data-id="${id}"]`;
  const applyFocus = () => {
    if (!focusAfter) return;
    shell.querySelector<HTMLElement>(focusAfter)?.focus();
    focusAfter = null;
  };

  let observer: IntersectionObserver | null = null;
  let subs: Promise<() => Promise<void>>[] = [];
  let offStore = () => {};
  let offConnect = () => {};

  // persistent elements
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` });
  const header = h("header", { class: "room-header" });
  const list = h("ol", { class: "messages", "aria-live": "polite", "aria-busy": "true", "aria-label": "Messages" });
  const topSentinel = h("li", { class: "sentinel", dataset: { sentinel: "top" }, "aria-hidden": "true" });
  const bottomSentinel = h("li", { class: "sentinel", dataset: { sentinel: "bottom" }, "aria-hidden": "true" });
  const beginning = h("li", { class: "beginning" });
  const pill = h("button", { type: "button", class: "new-messages", hidden: true });
  const footer = h("footer", { class: "room-footer" });
  const banner = h("p", { class: "archived-banner" }, "This room is archived. History is read-only.");
  const textarea = h("textarea", { name: "text", rows: 1, id: `${vid}-text`, autocomplete: "off" });
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const sendBtn = h("button", { type: "submit", disabled: true }, "Send");
  const composer = h("form", { class: "composer" }, [
    h("label", { for: `${vid}-text`, class: "visually-hidden" }, "Message"),
    textarea,
    counter,
    sendBtn,
  ]);

  const room = (): Room | undefined => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  const editable = (m: Message) => {
    const r = room();
    return !!r && !r.archived && m.author === me()?.id && !m.deleted && !m.status;
  };
  const find = (id: string) => win.items.find((m) => m.id === id);
  /** Local optimistic change that must win regardless of `updated` (edit/delete/revert). */
  const patchLocal = (id: string, patch: Partial<Message>) => {
    win = { ...win, items: win.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
  };
  const setRoom = (r: Room) => store.set((s) => ({ rooms: new Map(s.rooms).set(r.id, r) }));
  const scrollToBottom = () => (list.scrollTop = list.scrollHeight);

  // ---------------------------------------------------------------- rendering

  function messageNode(m: Message, groupStart: boolean): HTMLElement {
    const err = errors.get(m.id);
    const sig = JSON.stringify([
      m.text,
      m.deleted,
      m.edited_at,
      m.status ?? "",
      m.created,
      groupStart,
      editable(m),
      editing === m.id,
      confirmDelete === m.id,
      err?.text ?? "",
      targetId === m.id,
      m.expand?.author?.name ?? "",
    ]);
    const hit = cache.get(m.id);
    if (hit && hit.sig === sig) return hit.el;

    const { signal } = ac;
    const btn = (label: string, onClick: () => void, cls?: string) =>
      h("button", { type: "button", ...(cls ? { class: cls } : {}), on: { click: onClick }, signal }, label);
    const ms = parsePb(m.created);
    const name = m.expand?.author?.name ?? (m.author === me()?.id ? me()!.name : "Unknown");
    const cls = ["msg", groupStart && "group-start", m.status, m.deleted && "deleted", targetId === m.id && "target"].filter(Boolean).join(" ");

    const parts: (HTMLElement | null)[] = [];
    if (groupStart) {
      parts.push(
        h("div", { class: "meta" }, [
          h("span", { class: "author" }, name),
          h("time", { datetime: new Date(ms).toISOString(), title: formatFull(ms) }, formatTime(ms)),
        ]),
      );
    }
    if (editing === m.id) {
      const box = h("textarea", {
        class: "edit-input",
        rows: Math.min(6, m.text.split("\n").length),
        "aria-label": "Edit message",
        value: m.text,
        on: {
          keydown: (e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void saveEdit(m.id, (e.currentTarget as HTMLTextAreaElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              editing = null;
              render();
              textarea.focus();
            }
          },
        },
        signal,
      });
      parts.push(box, h("p", { class: "hint" }, "Enter to save · Esc to cancel"));
    } else {
      parts.push(
        m.deleted
          ? h("div", { class: "body placeholder" }, "Message deleted")
          : h("div", { class: "body" }, m.text),
      );
      if (m.edited_at && !m.deleted) parts.push(h("span", { class: "edited", title: `Edited ${formatFull(parsePb(m.edited_at))}` }, "(edited)"));
    }
    if (m.status === "failed") {
      parts.push(h("div", { class: "send-error" }, ["Not sent. ", btn("Retry", () => void retrySend(m.id)), btn("Discard", () => discard(m.id))]));
    }
    if (confirmDelete === m.id) {
      const cancel = () => {
        confirmDelete = null;
        focusAfter = `${msgSel(m.id)} .actions .delete`;
        render();
      };
      parts.push(
        h(
          "div",
          {
            class: "confirm",
            role: "group",
            "aria-label": "Confirm delete",
            on: { keydown: (e) => e.key === "Escape" && (e.preventDefault(), cancel()) },
            signal,
          },
          ["Delete this message? ", btn("Delete message", () => void doDelete(m.id), "danger"), btn("Cancel", cancel, "cancel")],
        ),
      );
    } else if (editable(m) && editing !== m.id) {
      parts.push(
        h("div", { class: "actions" }, [
          btn("Edit", () => startEdit(m.id), "edit"),
          btn(
            "Delete",
            () => {
              confirmDelete = m.id;
              focusAfter = `${msgSel(m.id)} .confirm .cancel`;
              render();
            },
            "delete",
          ),
        ]),
      );
    }
    if (err) parts.push(h("div", { class: "msg-error", role: "alert" }, [`${err.text} `, btn("Retry", err.retry)]));

    const el = h("li", { class: cls, dataset: { id: m.id } }, parts);
    cache.set(m.id, { sig, el });
    return el;
  }

  function divider(ms: number): HTMLElement {
    const label = dayLabel(ms);
    const key = `${new Date(ms).toDateString()}|${label}`;
    let el = dividers.get(key);
    if (!el) dividers.set(key, (el = h("li", { class: "day", role: "separator" }, label)));
    return el;
  }

  function render(opts: { anchor?: boolean } = {}) {
    if (!active) return;
    const r = room();
    beginning.textContent = r ? `Beginning of #${r.name}` : "Beginning of the room";
    const nodes: Node[] = [];
    if (win.hasOlder) nodes.push(topSentinel);
    else if (ready) nodes.push(beginning);
    let prev: Message | undefined;
    let prevDay = "";
    for (const m of win.items) {
      const ms = parsePb(m.created);
      const day = new Date(ms).toDateString();
      const newDay = day !== prevDay;
      if (newDay) nodes.push(divider(ms));
      nodes.push(messageNode(m, newDay || startsGroup(prev, m)));
      prev = m;
      prevDay = day;
    }
    if (win.hasNewer) nodes.push(bottomSentinel);

    const anchor = opts.anchor ? captureAnchor(list, "li.msg") : null;
    reconcile(list, nodes);
    if (anchor) restoreAnchor(list, anchor);

    // forget elements for messages no longer in the window
    const live = new Set(win.items.map((m) => m.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);

    applyFocus();
    if (focusEdit && editing) {
      focusEdit = false;
      const box = list.querySelector<HTMLTextAreaElement>(`li.msg[data-id="${editing}"] textarea.edit-input`);
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    }
  }

  function renderPill() {
    pill.hidden = pillMode === null;
    pill.textContent = pillMode === "history" ? "New messages · Jump to latest" : "↓ New messages";
  }

  function renderHeader() {
    const r = room();
    const { signal } = ac;
    const hidden = store.get().hidden.has(roomId);
    const mine = r?.created_by === me()?.id;
    const item = (label: string, fn: () => void) => h("button", { type: "button", on: { click: fn }, signal }, label);
    const closeMenu = () => {
      menuOpen = false;
      confirmArchive = false;
    };

    let items: HTMLElement[];
    if (r && confirmArchive) {
      items = [
        h("p", {}, `Archive “${r.name}”? It becomes read-only for everyone.`),
        h("button", { type: "button", class: "danger", on: { click: () => (closeMenu(), void roomAction(() => api.setArchived(roomId, true).then(setRoom))) }, signal }, "Archive"),
        h(
          "button",
          {
            type: "button",
            class: "cancel",
            on: {
              click: () => {
                confirmArchive = false;
                focusAfter = "header.room-header summary";
                renderHeader();
              },
            },
            signal,
          },
          "Cancel",
        ),
      ];
    } else {
      items = [];
      if (r && !r.archived) {
        items.push(
          hidden
            ? item("Unhide room", () => {
                closeMenu();
                void roomAction(async () => {
                  const rowId = store.get().hidden.get(roomId);
                  if (!rowId) return;
                  await api.unhideRoom(rowId);
                  store.set((s) => ({ hidden: new Map([...s.hidden].filter(([k]) => k !== roomId)) }));
                });
              })
            : item("Hide room", () => {
                closeMenu();
                void roomAction(async () => {
                  const row = await api.hideRoom(roomId);
                  store.set((s) => ({ hidden: new Map(s.hidden).set(roomId, row.id) }));
                });
              }),
        );
      }
      if (r && mine) {
        items.push(
          r.archived
            ? item("Unarchive room", () => (closeMenu(), void roomAction(() => api.setArchived(roomId, false).then(setRoom))))
            : item("Archive room", () => {
                confirmArchive = true;
                menuOpen = true;
                focusAfter = "header.room-header .menu-items .cancel";
                renderHeader();
              }),
        );
      }
      items.push(item("Jump to beginning", () => (closeMenu(), renderHeader(), void jump("first"))));
    }

    const menu = h(
      "details",
      {
        class: "menu",
        open: menuOpen,
        on: {
          toggle: (e) => {
            menuOpen = (e.currentTarget as HTMLDetailsElement).open;
            if (!menuOpen) confirmArchive = false;
          },
          keydown: (e) => {
            if (e.key !== "Escape" || !menuOpen) return;
            e.preventDefault();
            menuOpen = false;
            confirmArchive = false;
            focusAfter = "header.room-header summary";
            renderHeader();
          },
        },
        signal,
      },
      [h("summary", { "aria-label": "Room actions" }, "⋯"), h("div", { class: "menu-items" }, items)],
    );
    header.replaceChildren(
      h("a", { href: "#/", class: "back", "aria-label": "Back to rooms" }, "← Rooms"),
      h("h1", { id: `${vid}-title` }, r ? `#${r.name}` : ""),
      menu,
      headerError,
    );
    applyFocus();
  }
  const headerError = h("p", { class: "room-error", role: "alert" });

  async function roomAction(fn: () => Promise<unknown>) {
    renderHeader();
    try {
      await fn();
      headerError.textContent = "";
    } catch {
      if (active) headerError.textContent = "That didn't work. Check your connection and try again.";
    }
  }

  function renderFooter() {
    const r = room();
    if (!r) return footer.replaceChildren();
    if (r.archived) footer.replaceChildren(banner);
    else if (!composer.isConnected || footer.firstChild !== composer) footer.replaceChildren(composer);
    textarea.placeholder = `Message #${r.name}`;
  }

  function renderNotFound() {
    clear(shell);
    shell.append(h("p", { class: "not-found" }, ["This room doesn't exist. ", h("a", { href: "#/" }, "Back to rooms")]));
  }

  // ---------------------------------------------------------------- loading

  async function applyLoaded(kind: PageKind, page: Message[], g: number): Promise<boolean> {
    if (g !== gen || !active) return false;
    win = applyPage(win, page, kind).win;
    return true;
  }

  async function loadOlder() {
    if (!ready || !win.hasOlder || loadingOlder || !win.items.length) return;
    loadingOlder = true;
    const g = gen;
    try {
      const page = await api.page(older(roomId, win.items[0]!));
      if (await applyLoaded("older", page, g)) render({ anchor: true });
    } catch {
      /* the sentinel will trigger again */
    } finally {
      if (g === gen) loadingOlder = false;
    }
  }

  async function loadNewer() {
    if (!ready || !win.hasNewer || loadingNewer || !win.items.length) return;
    loadingNewer = true;
    const g = gen;
    try {
      const page = await api.page(newer(roomId, win.items.at(-1)!));
      if (await applyLoaded("newer", page, g)) render({ anchor: true });
    } catch {
      /* retry on next intersection */
    } finally {
      if (g === gen) loadingNewer = false;
    }
  }

  /** Reset the window to the latest page or the first page. */
  async function jump(kind: "latest" | "first") {
    const g = ++gen;
    loadingOlder = loadingNewer = false;
    pillMode = null;
    renderPill();
    const page = await api.page(kind === "latest" ? latest(roomId) : first(roomId)).catch(() => null);
    if (!page || !(await applyLoaded(kind, page, g))) return;
    targetId = null;
    render();
    if (kind === "latest") scrollToBottom();
    else list.scrollTop = 0;
  }

  async function loadAround(msgId: string): Promise<boolean> {
    let target: Message;
    try {
      target = await api.getMessage(msgId);
    } catch {
      return false;
    }
    if (target.room !== roomId) return false;
    const [before, after] = await Promise.all([api.page(older(roomId, target)), api.page(newer(roomId, target))]);
    win = merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [...before, target, ...after]);
    targetId = target.id;
    return true;
  }

  async function open(msgId: string | undefined) {
    const g = ++gen;
    const roomP = api.getRoom(roomId).then(setRoom);
    const pageP = (async () => {
      if (msgId && (await loadAround(msgId))) return "target" as const;
      win = applyPage(emptyWindow(), await api.page(latest(roomId)), "latest").win;
      return "latest" as const;
    })();
    pageP.catch(() => {}); // handled below; but we may return early (room not found) without awaiting it
    try {
      await roomP;
    } catch (e) {
      if (active && e instanceof ApiError && e.status === 404) renderNotFound();
      return;
    }
    let mode: "target" | "latest";
    try {
      mode = await pageP;
    } catch {
      mode = "latest";
    }
    if (!active || g !== gen) return;
    ready = true;
    list.setAttribute("aria-busy", "false");
    renderHeader();
    renderFooter();
    render();
    if (mode === "target" && targetId) {
      const el = list.querySelector<HTMLElement>(`li.msg[data-id="${targetId}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2;
    } else {
      scrollToBottom();
    }
    const pending = buffer;
    buffer = [];
    for (const [action, m] of pending) onMessage(action, m);
  }

  /** At the live edge after a reconnect: fetch everything newer than what we have (§7.5). */
  async function gapFill() {
    const g = gen;
    const wasNear = isNearBottom(list);
    for (;;) {
      const last = [...win.items].reverse().find((m) => !m.status);
      const page = await api.page(last ? newer(roomId, last) : latest(roomId)).catch(() => null);
      if (!page || g !== gen || !active) return;
      win = last ? applyPage(win, page, "newer").win : applyPage(win, page, "latest").win;
      if (page.length < PAGE_SIZE) break;
    }
    win = { ...win, hasNewer: false };
    render({ anchor: !wasNear });
    if (wasNear) scrollToBottom();
  }

  // ---------------------------------------------------------------- realtime

  function onMessage(action: Action, m: Message) {
    if (!active || m.room !== roomId) return;
    if (!ready) {
      buffer.push([action, m]);
      return;
    }
    if (action === "delete") {
      win = remove(win, m.id);
      render({ anchor: true });
      return;
    }
    if (action === "update") {
      if (!find(m.id)) return;
      win = merge(win, [m]);
      render({ anchor: true });
      return;
    }
    // create
    if (find(m.id)) {
      win = merge(win, [m]);
      render();
      return;
    }
    if (win.hasNewer) {
      pillMode = "history";
      renderPill();
      return;
    }
    const follow = isNearBottom(list) || m.author === me()?.id;
    win = trim(merge(win, [m]), "top").win;
    render({ anchor: !follow });
    if (follow) scrollToBottom();
    else if (pillMode !== "history") {
      pillMode = "below";
      renderPill();
    }
  }

  // ---------------------------------------------------------------- sending

  const composerValid = () => {
    const t = textarea.value.trim();
    return t.length > 0 && t.length <= MAX_LEN;
  };

  function onComposerInput() {
    const len = textarea.value.length;
    counter.textContent = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;
    textarea.rows = Math.min(6, textarea.value.split("\n").length);
    sendBtn.disabled = !composerValid();
  }

  async function submit() {
    const user = me();
    const r = room();
    if (!composerValid() || !user || !r || r.archived) return;
    const text = textarea.value.trim();
    textarea.value = "";
    onComposerInput();
    if (win.hasNewer) await jump("latest");
    const last = win.items.at(-1);
    const created = toPb(Math.max(Date.now(), last ? parsePb(last.created) + 1 : 0));
    const msg: Message = {
      id: newId(),
      room: roomId,
      author: user.id,
      text,
      created,
      updated: created,
      edited_at: "",
      deleted: false,
      expand: { author: { id: user.id, name: user.name } },
      status: "pending",
    };
    win = trim(merge(win, [msg]), "top").win;
    pillMode = null;
    renderPill();
    render();
    scrollToBottom();
    await deliver(msg);
  }

  async function deliver(msg: Message) {
    try {
      const saved = await api.send({ id: msg.id, room: msg.room, text: msg.text });
      if (!active) return;
      win = merge(win, [saved]);
    } catch (e) {
      if (!active) return;
      // A retry of a send that already reached the server fails with a duplicate id: it was sent after all.
      const recovered = e instanceof ApiError && e.status === 400 ? await api.getMessage(msg.id).catch(() => null) : null;
      if (recovered && recovered.author === me()?.id) win = merge(win, [recovered]);
      else if (find(msg.id)?.status) win = merge(win, [{ ...msg, status: "failed" }]);
    }
    render();
  }

  async function retrySend(id: string) {
    const m = find(id);
    if (!m || m.status !== "failed") return;
    const pending = { ...m, status: "pending" as const };
    patchLocal(id, { status: "pending" });
    render();
    await deliver(pending);
  }

  function discard(id: string) {
    win = remove(win, id);
    render();
  }

  // ---------------------------------------------------------------- edit / delete

  function startEdit(id: string) {
    editing = id;
    confirmDelete = null;
    focusEdit = true;
    render();
  }

  async function saveEdit(id: string, raw: string) {
    const m = find(id);
    if (!m) return;
    const text = raw.trim();
    if (!text || text.length > MAX_LEN) return;
    editing = null;
    errors.delete(id);
    if (text === m.text) {
      render();
      textarea.focus();
      return;
    }
    const before = { text: m.text, edited_at: m.edited_at };
    patchLocal(id, { text });
    render({ anchor: true });
    textarea.focus();
    try {
      const saved = await api.edit(id, text);
      if (active) win = merge(win, [saved]);
    } catch {
      if (!active) return;
      patchLocal(id, before);
      errors.set(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    }
    render({ anchor: true });
  }

  async function doDelete(id: string) {
    const m = find(id);
    confirmDelete = null;
    errors.delete(id);
    if (!m) return;
    const before = { text: m.text, deleted: false };
    patchLocal(id, { text: "", deleted: true });
    render({ anchor: true });
    try {
      const saved = await api.softDelete(id);
      if (active) win = merge(win, [saved]);
    } catch {
      if (!active) return;
      patchLocal(id, before);
      errors.set(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    }
    render({ anchor: true });
  }

  // ---------------------------------------------------------------- lifecycle

  return {
    mount(el, params) {
      root = el;
      active = true;
      ac = new AbortController();
      const { signal } = ac;
      roomId = params.id!;
      targetId = null;
      win = emptyWindow();
      ready = false;
      buffer = [];
      pillMode = null;
      list.setAttribute("aria-busy", "true");

      textarea.addEventListener("input", onComposerInput, { signal });
      textarea.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === "ArrowUp" && textarea.value === "") {
            const mine = lastOwnEditable(win, me()?.id ?? "");
            if (mine && editable(mine)) {
              e.preventDefault();
              startEdit(mine.id);
            }
          }
        },
        { signal },
      );
      composer.addEventListener("submit", (e) => (e.preventDefault(), void submit()), { signal });
      pill.addEventListener("click", () => {
        if (pillMode === "history") void jump("latest");
        else {
          scrollToBottom();
          pillMode = null;
          renderPill();
        }
      }, { signal });
      list.addEventListener("scroll", () => {
        if (pillMode === "below" && isNearBottom(list)) {
          pillMode = null;
          renderPill();
        }
      }, { signal });

      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting || !list.contains(e.target)) continue;
            if (e.target === topSentinel) void loadOlder();
            if (e.target === bottomSentinel) void loadNewer();
          }
        },
        { root: list, rootMargin: "300px 0px" },
      );
      observer.observe(topSentinel);
      observer.observe(bottomSentinel);

      shell.replaceChildren(header, h("div", { class: "room-body" }, [list, pill]), footer);
      clear(root);
      root.append(shell);
      onComposerInput();
      renderPill();
      renderHeader();
      renderFooter();

      store.set({ activeRoomId: roomId });
      offStore = store.subscribe((s, prev) => {
        const roomChanged = s.rooms.get(roomId) !== prev.rooms.get(roomId);
        if (roomChanged || s.hidden !== prev.hidden || s.user !== prev.user) {
          renderHeader();
          renderFooter();
          if (roomChanged) render();
        }
      });
      subs = [
        api.subscribeMessages(roomId, onMessage),
        api.subscribeRooms((action, r) => {
          if (!active || r.id !== roomId) return;
          if (action !== "delete") setRoom(r);
        }),
      ];
      offConnect = api.onConnect((reconnect) => {
        if (!reconnect || !active) return;
        void api.getRoom(roomId).then((r) => active && setRoom(r)).catch(() => {});
        if (ready && !win.hasNewer) void gapFill();
      });
      void open(params.msgId);
    },
    unmount() {
      active = false;
      gen++;
      ac.abort();
      observer?.disconnect();
      observer = null;
      offStore();
      offConnect();
      for (const p of subs) void p.then((off) => off()).catch(() => {});
      subs = [];
      cache.clear();
      dividers.clear();
      errors.clear();
      editing = confirmDelete = null;
      menuOpen = confirmArchive = false;
      textarea.value = "";
      store.set({ activeRoomId: null });
      clear(root);
    },
  };
}
