// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, archived mode, read state (§18.3).
// This module owns the message window and everything that changes it (loading, realtime, sending, edits).
// The DOM parts live in room/: header (title + actions menu), messages (the list), composer.

import { type Action, ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { changedIn, first, latest, newer, older, PAGE_SIZE } from "../lib/cursor.ts";
import { newId } from "../lib/id.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import { applyPage, emptyWindow, lastOwnEditable, type MessageWindow, merge, type PageKind, remove, trim } from "../lib/messages.ts";
import { isDm, otherMember, roomTitle } from "../lib/rooms.ts";
import { isNearBottom } from "../lib/scroll.ts";
import { parsePb, toPb } from "../lib/time.ts";
import type { LocalFile, Message, Room, User } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import { clearUnread, upsertRoom } from "../store.ts";
import { createComposer, validText } from "./room/composer.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList } from "./room/messages.ts";

/** How long the room view batches read positions before telling the server (§18.3). */
const READ_DELAY_MS = 1000;

export function createRoomView({ api, store, sync, actions, navigate }: Ctx): View {
  const vid = uniqueId("room");
  const scope = createScope();
  const { signal } = scope;
  let root: HTMLElement;
  let roomId = "";
  let targetId: string | null = null;
  /** The message the route asked for (#/r/:id/m/:msgId), kept for a retry of the initial load. */
  let currentMsgId: string | undefined;

  // message window state
  let win: MessageWindow = emptyWindow();
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  let ready = false;
  /** The initial load failed (not a 404): the list shows an error with Retry instead of messages. */
  let failed = false;
  /** Realtime events that arrive before the first page; replayed once it is in. */
  let buffer: [Action, Message][] = [];
  const loading = { top: false, bottom: false };
  let pillMode: "below" | "history" | null = null;
  /** Read up to here (a message's `created`): sent, or about to be when `readTimer` fires. */
  let readAt = "";
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whose reads these are: the session is shared with other tabs, which may switch it to someone else. */
  let reader = "";

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

  const header = createRoomHeader({
    titleId: `${vid}-title`,
    actions,
    avatarUrl: api.avatarUrl,
    onJumpToBeginning: () => void jump("first"),
    onClosed: () => navigate("#/"),
    signal,
  });
  /** "Beginning of #general" / "Beginning of your conversation with Bob". */
  const beginningLabel = () => {
    const r = room();
    if (!r) return "Beginning of the room";
    return isDm(r) ? `Beginning of your conversation with ${otherMember(r, me())?.name ?? "Unknown"}` : `Beginning of #${r.name}`;
  };
  const messages = createMessageList({
    state: () => ({ win, ready, failed, beginning: beginningLabel(), targetId }),
    me,
    editable,
    onRetryLoad: () => retryLoad(),
    onSaveEdit: (id, text) => void saveEdit(id, text),
    onCancelEdit: () => composer.focus(),
    onDelete: (id) => void doDelete(id),
    onRetrySend: (id) => void retrySend(id),
    onDiscard: (id) => {
      revokeLocal(find(id));
      win = remove(win, id);
      render();
    },
    fileUrl: api.fileUrl,
    refreshFileToken: () => api.fileToken(true),
    avatarUrl: api.avatarUrl,
    onMessageUser: (userId) => void messageUser(userId),
    signal,
  });
  const composer = createComposer({
    id: `${vid}-text`,
    onSend: (text, files) => {
      const user = me();
      const r = room();
      if (!user || !r || r.archived) return false;
      void send(text, user, files);
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
  const notice = h("p", { class: "room-notice", role: "status" });
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` }, [
    header.el,
    notice,
    h("div", { class: "room-body" }, [list, pill]),
    footer,
  ]);

  /** Render the list, then mark what it shows as read. */
  function render(o?: { anchor?: boolean }) {
    messages.render(o);
    markRead();
  }

  /**
   * The newest messages are on screen (§18.3): loaded, scrolled to the bottom, in a visible tab. Scrolled up, a new
   * message only shows the pill, and stays unread until you scroll down to it.
   */
  const atLiveEdge = () => ready && !failed && !win.hasNewer && isNearBottom(list) && document.visibilityState !== "hidden";

  function markRead() {
    if (!atLiveEdge()) return;
    let newest: Message | undefined;
    for (let i = win.items.length - 1; i >= 0 && !newest; i--) if (!win.items[i]!.status) newest = win.items[i];
    if (!newest || newest.created <= readAt) return;
    readAt = newest.created;
    store.set(clearUnread(roomId));
    readTimer ??= setTimeout(sendRead, READ_DELAY_MS);
  }

  function sendRead() {
    clearTimeout(readTimer);
    readTimer = undefined;
    if (api.currentUser()?.id !== reader) return; // never as someone else
    const at = readAt;
    api.markRead(roomId, at).catch(() => {
      // Try again on the next render or scroll (a reconnect's gap fill renders).
      if (readAt === at && scope.active) readAt = "";
    });
  }

  /** Release a local message's preview URLs (sent, discarded, or the view is going away). */
  function revokeLocal(m: Message | undefined) {
    for (const f of m?.localFiles ?? []) if (f.url) URL.revokeObjectURL(f.url);
  }
  function scrollToBottom() {
    list.scrollTop = list.scrollHeight;
    markRead();
  }

  function setPill(mode: typeof pillMode) {
    pillMode = mode;
    pill.hidden = mode === null;
    pill.textContent = mode === "history" ? "New messages · Jump to latest" : "↓ New messages";
  }

  function renderHeader() {
    header.update({ room: room(), hidden: store.get().hidden.has(roomId), me: me() });
  }

  /** "Message" on an author: open the DM with them (§16.5). */
  async function messageUser(userId: string) {
    try {
      const dm = await actions.openDm(userId);
      if (scope.active) navigate(`#/r/${dm.id}`);
    } catch (e) {
      if (scope.active) notice.textContent = `Couldn't open that conversation. ${errorMessage(e)}`;
    }
  }

  function renderFooter() {
    const r = room();
    // No composer while the room failed to load: you'd be writing into history you can't see.
    // (The composer element, and anything typed into it, is kept for when the load succeeds.)
    if (!r || failed) return footer.replaceChildren();
    if (r.archived) footer.replaceChildren(banner);
    else if (footer.firstChild !== composer.el) footer.replaceChildren(composer.el);
    composer.setPlaceholder(`Message ${roomTitle(r, me())}`);
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
      const page =
        side === "top" ? await api.page(older(roomId, win.items[0]!), signal) : await api.page(newer(roomId, win.items.at(-1)!), signal);
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
    const page = await api.page(kind === "latest" ? latest(roomId) : first(roomId), signal).catch(() => null);
    if (!page || !applyLoaded(kind, page, g)) return;
    targetId = null;
    notice.textContent = "";
    render();
    if (kind === "latest") scrollToBottom();
    else list.scrollTop = 0;
  }

  /** The window around message `msgId`, or null when it isn't in this room. Rejects if a page fails. */
  async function windowAround(msgId: string): Promise<{ win: MessageWindow; target: string } | null> {
    // A missing message falls back to the latest page; any other failure fails the load (and offers Retry).
    const target = await api.getMessage(msgId, signal).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    if (!target || target.room !== roomId) return null;
    const [before, after] = await Promise.all([api.page(older(roomId, target), signal), api.page(newer(roomId, target), signal)]);
    const win = merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [
      ...before,
      target,
      ...after,
    ]);
    return { win, target: target.id };
  }

  async function open(msgId: string | undefined) {
    const g = ++gen;
    const roomP = api.getRoom(roomId, signal).then((r) => store.set(upsertRoom(r)));
    // Attachment URLs need a file token: have one before the first render, so images don't fail first.
    const tokenP = api.fileToken().catch(() => "");
    // Loaders only return a window; it is committed below, and only if nothing (a jump) replaced it meanwhile.
    const pageP = (async () => {
      const around = msgId ? await windowAround(msgId) : null;
      return around ?? { win: applyPage(emptyWindow(), await api.page(latest(roomId), signal), "latest").win, target: null };
    })();
    pageP.catch(() => {}); // handled below; but we may return early (room not found) without awaiting it
    try {
      await roomP;
    } catch (e) {
      if (!scope.active) return;
      if (e instanceof ApiError && e.status === 404) renderNotFound();
      else renderFailed();
      return;
    }
    const loaded = await pageP.catch(() => null);
    await tokenP;
    if (!scope.active) return;
    const current = g === gen;
    // Never show a failed load as an empty room ("Beginning of #room"): say so and offer Retry.
    if (current && !loaded) return renderFailed();
    if (current && loaded) {
      win = loaded.win;
      targetId = loaded.target;
      notice.textContent = msgId && !loaded.target ? "That message isn't in this room. Showing the latest messages instead." : "";
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

  /** The initial load failed for a reason other than "no such room". Retry is in the list (messages.ts). */
  function renderFailed() {
    if (!scope.active) return;
    failed = true;
    list.setAttribute("aria-busy", "false");
    renderHeader();
    renderFooter();
    render();
  }

  function retryLoad() {
    if (!failed || !scope.active) return;
    failed = false;
    list.setAttribute("aria-busy", "true");
    render();
    void open(currentMsgId);
  }

  /**
   * After a reconnect: re-fetch the messages in the window that changed while realtime was down, so edits and
   * deletes missed meanwhile apply (a deleted message must not keep showing its text). Newer messages are
   * gapFill's job.
   */
  async function refreshWindow() {
    const g = gen;
    const known = win.items.filter((m) => !m.status);
    const oldest = known[0];
    const newest = known.at(-1);
    if (!oldest || !newest) return;
    // Any change made after the newest `updated` we have was made by the server later: it is newer than that.
    const since = known.reduce((max, m) => (m.updated > max ? m.updated : max), "");
    const changed = await api.changes(changedIn(roomId, since, oldest, newest), signal).catch(() => null);
    if (!changed || g !== gen || !scope.active) return;
    const inWindow = changed.filter((m) => find(m.id));
    if (!inWindow.length) return;
    win = merge(win, inWindow);
    render({ anchor: true });
  }

  /** At the live edge after a reconnect: fetch everything newer than what we have (§7.5). */
  async function gapFill() {
    const g = gen;
    const wasNear = isNearBottom(list);
    for (;;) {
      const last = [...win.items].reverse().find((m) => !m.status);
      const page = await api.page(last ? newer(roomId, last) : latest(roomId), signal).catch(() => null);
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

  async function send(text: string, user: User, files: LocalFile[] = []) {
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
      expand: { author: { id: user.id, name: user.name, avatar: user.avatar ?? "" } },
      status: "pending",
      ...(files.length ? { localFiles: files } : {}),
    };
    win = trim(merge(win, [msg]), "top").win;
    setPill(null);
    render();
    scrollToBottom();
    await deliver(msg);
  }

  async function deliver(msg: Message) {
    try {
      const files = msg.localFiles?.map((f) => f.file);
      const saved = await api.send({ id: msg.id, room: msg.room, text: msg.text, ...(files?.length ? { files } : {}) });
      if (!scope.active) return;
      win = merge(win, [saved]);
      render();
      revokeLocal(msg);
      return;
    } catch (e) {
      if (!scope.active) return;
      // A retry of a send that already reached the server fails with a duplicate id: it was sent after all.
      const recovered = e instanceof ApiError && e.status === 400 ? await api.getMessage(msg.id, signal).catch(() => null) : null;
      if (recovered && recovered.author === me()?.id) {
        win = merge(win, [recovered]);
        revokeLocal(msg);
      } else if (find(msg.id)?.status) win = merge(win, [{ ...msg, status: "failed" }]);
    }
    render();
  }

  async function retrySend(id: string) {
    const m = find(id);
    if (m?.status !== "failed") return;
    patchLocal(id, { status: "pending" });
    render();
    await deliver({ ...m, status: "pending" });
  }

  // ---------------------------------------------------------------- edit / delete

  async function saveEdit(id: string, raw: string) {
    const m = find(id);
    // Text may be emptied next to attachments (§17.1).
    const text = m?.files?.length ? (textLength(raw.trim()) <= LIMITS.messageText ? raw.trim() : null) : validText(raw);
    if (!m || text === null) return; // the edit box says what is wrong (messages.ts)
    messages.stopEdit();
    if (!editable(m)) {
      // Deleted elsewhere or the room was archived while the box was open: nothing left to save.
      render();
      composer.focus();
      return;
    }
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
      currentMsgId = params.msgId;

      pill.addEventListener(
        "click",
        () => {
          if (pillMode === "history") return void jump("latest");
          scrollToBottom();
          setPill(null);
        },
        { signal },
      );
      list.addEventListener("scroll", () => pillMode === "below" && isNearBottom(list) && setPill(null), { signal });
      document.addEventListener("visibilitychange", markRead, { signal });
      list.addEventListener("scroll", markRead, { signal });
      // When the list gets shorter (the attachment tray opens, the textarea grows, the keyboard opens) while it is
      // at the live bottom, keep it there instead of letting the newest messages slide under the composer (BUG-31).
      let pinned = true;
      list.addEventListener("scroll", () => (pinned = isNearBottom(list)), { signal });
      if (typeof ResizeObserver === "function") {
        const resizes = new ResizeObserver(() => {
          if (pinned && ready && !win.hasNewer) scrollToBottom();
        });
        resizes.observe(list);
        scope.defer(() => resizes.disconnect());
      }
      // Files dropped anywhere on the room go to the composer (§17.4).
      const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
      shell.addEventListener("dragover", (e) => hasFiles(e) && footer.contains(composer.el) && e.preventDefault(), { signal });
      shell.addEventListener(
        "drop",
        (e) => {
          if (!hasFiles(e) || !footer.contains(composer.el)) return;
          e.preventDefault();
          void composer.addFiles([...(e.dataTransfer?.files ?? [])]);
        },
        { signal },
      );
      // Keep a fresh file token for attachment URLs (§17.3); it only fetches when the cached one is old.
      const keepToken = setInterval(() => void api.fileToken().catch(() => {}), 30_000);
      scope.defer(() => clearInterval(keepToken));
      scope.defer(() => {
        for (const m of win.items) revokeLocal(m);
      });

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

      reader = me()?.id ?? "";
      store.set({ activeRoomId: roomId });
      scope.defer(() => store.set({ activeRoomId: null }));
      // Leaving: send a pending read now. Messages that came in while you weren't at the live edge weren't counted
      // (this was the active room), so ask the server for the real number.
      scope.defer(() => {
        if (readTimer) sendRead();
        if (atLiveEdge()) store.set(clearUnread(roomId));
        else sync.refreshUnread();
      });
      scope.defer(
        store.subscribe((s, prev) => {
          // Logging out: send a pending read while the session is still there (sendRead checks it is still ours).
          if (s.user?.id !== reader && readTimer) sendRead();
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
          if (!reconnect || !scope.active) return;
          if (failed) return retryLoad(); // back online: try the initial load again
          if (!ready) return;
          void refreshWindow();
          if (!win.hasNewer) void gapFill();
        }),
      );
      void open(currentMsgId);
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
