// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, archived mode.
// This module owns the message window and everything that changes it (loading, realtime, sending, edits).
// The DOM parts live in room/: header (title + actions menu), messages (the list), composer.

import { ApiError, type Action } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import { PAGE_SIZE, first, latest, newer, older } from "../lib/cursor.ts";
import { newId } from "../lib/id.ts";
import { applyPage, emptyWindow, lastOwnEditable, merge, remove, trim, type MessageWindow, type PageKind } from "../lib/messages.ts";
import { isNearBottom } from "../lib/scroll.ts";
import { parsePb, toPb } from "../lib/time.ts";
import type { Message, Room } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import { upsertRoom } from "../store.ts";
import { createComposer, validText } from "./room/composer.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList } from "./room/messages.ts";

let uid = 0;

export function createRoomView({ api, store, actions }: Ctx): View {
  const vid = `room-${++uid}`;
  const scope = createScope();
  const { signal } = scope;
  let root: HTMLElement;
  let roomId = "";
  let targetId: string | null = null;

  // message window state
  let win: MessageWindow = emptyWindow();
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  let ready = false;
  /** Realtime events that arrive before the first page; replayed once it is in. */
  let buffer: [Action, Message][] = [];
  const loading = { top: false, bottom: false };
  let pillMode: "below" | "history" | null = null;

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

  // ---------------------------------------------------------------- parts

  const header = createRoomHeader({ titleId: `${vid}-title`, actions, onJumpToBeginning: () => void jump("first"), signal });
  const messages = createMessageList({
    state: () => ({ win, ready, roomName: room()?.name, targetId }),
    me,
    editable,
    onSaveEdit: (id, text) => void saveEdit(id, text),
    onCancelEdit: () => composer.focus(),
    onDelete: (id) => void doDelete(id),
    onRetrySend: (id) => void retrySend(id),
    onDiscard: (id) => {
      win = remove(win, id);
      render();
    },
    signal,
  });
  const composer = createComposer({
    id: `${vid}-text`,
    onSend: (text) => {
      const user = me();
      const r = room();
      if (!user || !r || r.archived) return false;
      void send(text, user);
      return true;
    },
    onEditLast: () => {
      const mine = lastOwnEditable(win, me()?.id ?? "");
      if (!mine || !editable(mine)) return false;
      messages.startEdit(mine.id);
      return true;
    },
    signal,
  });
  const list = messages.el;
  const pill = h("button", { type: "button", class: "new-messages", hidden: true });
  const footer = h("footer", { class: "room-footer" });
  const banner = h("p", { class: "archived-banner" }, "This room is archived. History is read-only.");
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` }, [
    header.el,
    h("div", { class: "room-body" }, [list, pill]),
    footer,
  ]);

  const render = messages.render;
  const scrollToBottom = () => (list.scrollTop = list.scrollHeight);

  function setPill(mode: typeof pillMode) {
    pillMode = mode;
    pill.hidden = mode === null;
    pill.textContent = mode === "history" ? "New messages · Jump to latest" : "↓ New messages";
  }

  function renderHeader() {
    const r = room();
    header.update({ room: r, hidden: store.get().hidden.has(roomId), mine: !!r && r.created_by === me()?.id });
  }

  function renderFooter() {
    const r = room();
    if (!r) return footer.replaceChildren();
    if (r.archived) footer.replaceChildren(banner);
    else if (footer.firstChild !== composer.el) footer.replaceChildren(composer.el);
    composer.setPlaceholder(`Message #${r.name}`);
  }

  function renderNotFound() {
    shell.replaceChildren(h("p", { class: "not-found" }, ["This room doesn't exist. ", h("a", { href: "#/" }, "Back to rooms")]));
  }

  // ---------------------------------------------------------------- loading

  /** Apply a page fetched under generation `g`, unless a jump (or unmount) has made it stale. */
  function applyLoaded(kind: PageKind, page: Message[], g: number): boolean {
    if (g !== gen || !scope.active) return false;
    win = applyPage(win, page, kind).win;
    return true;
  }

  /** Extend the window at one end (a sentinel came into view). One request per end at a time. */
  async function loadEdge(side: "top" | "bottom") {
    const more = side === "top" ? win.hasOlder : win.hasNewer;
    if (!ready || !more || loading[side] || !win.items.length) return;
    loading[side] = true;
    const g = gen;
    try {
      const page = side === "top" ? await api.page(older(roomId, win.items[0]!)) : await api.page(newer(roomId, win.items.at(-1)!));
      if (applyLoaded(side === "top" ? "older" : "newer", page, g)) render({ anchor: true });
    } catch {
      /* the sentinel will trigger again */
    } finally {
      if (g === gen) loading[side] = false;
    }
  }

  /** Reset the window to the latest page or the first page. */
  async function jump(kind: "latest" | "first") {
    const g = ++gen;
    loading.top = loading.bottom = false;
    setPill(null);
    const page = await api.page(kind === "latest" ? latest(roomId) : first(roomId)).catch(() => null);
    if (!page || !applyLoaded(kind, page, g)) return;
    targetId = null;
    render();
    if (kind === "latest") scrollToBottom();
    else list.scrollTop = 0;
  }

  /** The window around message `msgId`, or null when it isn't in this room. Rejects if a page fails. */
  async function windowAround(msgId: string): Promise<{ win: MessageWindow; target: string } | null> {
    const target = await api.getMessage(msgId).catch(() => null);
    if (!target || target.room !== roomId) return null;
    const [before, after] = await Promise.all([api.page(older(roomId, target)), api.page(newer(roomId, target))]);
    const win = merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [...before, target, ...after]);
    return { win, target: target.id };
  }

  async function open(msgId: string | undefined) {
    const g = ++gen;
    const roomP = api.getRoom(roomId).then((r) => store.set(upsertRoom(r)));
    // Loaders only return a window; it is committed below, and only if nothing (a jump) replaced it meanwhile.
    const pageP = (async () => {
      const around = msgId ? await windowAround(msgId) : null;
      return around ?? { win: applyPage(emptyWindow(), await api.page(latest(roomId)), "latest").win, target: null };
    })();
    pageP.catch(() => {}); // handled below; but we may return early (room not found) without awaiting it
    try {
      await roomP;
    } catch (e) {
      if (scope.active && e instanceof ApiError && e.status === 404) renderNotFound();
      return;
    }
    const loaded = await pageP.catch(() => null);
    if (!scope.active) return;
    const current = g === gen;
    if (current && loaded) {
      win = loaded.win;
      targetId = loaded.target;
    }
    // Ready either way: a jump made during the load already owns the window, but still needs the view live.
    ready = true;
    list.setAttribute("aria-busy", "false");
    renderHeader();
    renderFooter();
    render();
    if (current && targetId) {
      const el = list.querySelector<HTMLElement>(`li.msg[data-id="${CSS.escape(targetId)}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2;
    } else if (current) {
      scrollToBottom(); // otherwise the jump has positioned the list
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
      if (!page || g !== gen || !scope.active) return;
      win = applyPage(win, page, last ? "newer" : "latest").win;
      if (page.length < PAGE_SIZE) break;
    }
    win = { ...win, hasNewer: false };
    render({ anchor: !wasNear });
    if (wasNear) scrollToBottom();
  }

  // ---------------------------------------------------------------- realtime

  function onMessage(action: Action, m: Message) {
    if (!scope.active || m.room !== roomId) return;
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
      setPill("history");
      return;
    }
    const follow = isNearBottom(list) || m.author === me()?.id;
    win = trim(merge(win, [m]), "top").win;
    render({ anchor: !follow });
    if (follow) scrollToBottom();
    else if (pillMode !== "history") setPill("below");
  }

  // ---------------------------------------------------------------- sending

  async function send(text: string, user: { id: string; name: string }) {
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
    setPill(null);
    render();
    scrollToBottom();
    await deliver(msg);
  }

  async function deliver(msg: Message) {
    try {
      const saved = await api.send({ id: msg.id, room: msg.room, text: msg.text });
      if (!scope.active) return;
      win = merge(win, [saved]);
    } catch (e) {
      if (!scope.active) return;
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
    patchLocal(id, { status: "pending" });
    render();
    await deliver({ ...m, status: "pending" });
  }

  // ---------------------------------------------------------------- edit / delete

  async function saveEdit(id: string, raw: string) {
    const m = find(id);
    const text = validText(raw);
    if (!m || text === null) return;
    messages.stopEdit();
    messages.setError(id, null);
    if (text === m.text) {
      render();
      composer.focus();
      return;
    }
    const before = { text: m.text, edited_at: m.edited_at };
    patchLocal(id, { text });
    render({ anchor: true });
    composer.focus();
    try {
      const saved = await api.edit(id, text);
      if (scope.active) win = merge(win, [saved]);
    } catch {
      if (!scope.active) return;
      patchLocal(id, before);
      messages.setError(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    }
    render({ anchor: true });
  }

  async function doDelete(id: string) {
    const m = find(id);
    messages.setError(id, null);
    if (!m) return;
    const before = { text: m.text, deleted: false };
    patchLocal(id, { text: "", deleted: true });
    render({ anchor: true });
    try {
      const saved = await api.softDelete(id);
      if (scope.active) win = merge(win, [saved]);
    } catch {
      if (!scope.active) return;
      patchLocal(id, before);
      messages.setError(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    }
    render({ anchor: true });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Single use: the router and the sidebar layout create a fresh view for every mount. */
  return {
    mount(el, params) {
      root = el;
      roomId = params.id!;

      pill.addEventListener("click", () => (pillMode === "history" ? void jump("latest") : (scrollToBottom(), setPill(null))), { signal });
      list.addEventListener("scroll", () => pillMode === "below" && isNearBottom(list) && setPill(null), { signal });

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting || !list.contains(e.target)) continue;
            if (e.target === messages.topSentinel) void loadEdge("top");
            if (e.target === messages.bottomSentinel) void loadEdge("bottom");
          }
        },
        { root: list, rootMargin: "300px 0px" },
      );
      observer.observe(messages.topSentinel);
      observer.observe(messages.bottomSentinel);
      scope.defer(() => observer.disconnect());

      clear(root);
      root.append(shell);
      setPill(null);
      renderHeader();
      renderFooter();

      store.set({ activeRoomId: roomId });
      scope.defer(() => store.set({ activeRoomId: null }));
      scope.defer(
        store.subscribe((s, prev) => {
          const roomChanged = s.rooms.get(roomId) !== prev.rooms.get(roomId);
          if (roomChanged || s.hidden !== prev.hidden || s.user !== prev.user) {
            renderHeader();
            renderFooter();
            if (roomChanged) render();
          }
        }),
      );
      // Room record changes (archive etc.) arrive through the store, kept live by sync.ts.
      scope.sub(api.subscribeMessages(roomId, onMessage));
      scope.defer(
        api.onConnect((reconnect) => {
          if (reconnect && scope.active && ready && !win.hasNewer) void gapFill();
        }),
      );
      void open(params.msgId);
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
