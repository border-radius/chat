// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, archived mode, read state (§18.3).
// The message window and everything that changes it live in room/controller.ts (no DOM). This module puts the
// controller's changes on screen and wires the DOM parts in room/: header (title + actions menu), messages (the
// list), composer.

import { errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { lastSaved } from "../lib/messages.ts";
import { isDm, otherMember, roomTitle } from "../lib/rooms.ts";
import { isNearBottom } from "../lib/scroll.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import type { RoomReader } from "../unread.ts";
import { createComposer, validEdit } from "./room/composer.ts";
import { type Change, createRoomController, type Phase, type RoomController } from "./room/controller.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList } from "./room/messages.ts";

export function createRoomView({ api, store, unread, actions, navigate }: Ctx): View {
  const vid = uniqueId("room");
  const scope = createScope();
  const { signal } = scope;
  let root: HTMLElement;
  let roomId = "";
  /** Created on mount, when the room id is known. */
  let ctl: RoomController;
  /** The phase the header, footer and list were last drawn for. */
  let shown: Phase = "loading";
  /** Reports what is on screen as read (unread.ts), from mount on. */
  let reader: RoomReader | null = null;

  const room = () => store.get().rooms.get(roomId);
  const me = () => store.get().user;

  // ---------------------------------------------------------------- parts

  const header = createRoomHeader({
    titleId: `${vid}-title`,
    actions,
    avatarUrl: api.avatarUrl,
    onJumpToBeginning: () => void ctl.jump("first"),
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
    state: () => {
      const s = ctl.state();
      return { win: s.win, ready: s.phase === "ready", failed: s.phase === "failed", beginning: beginningLabel(), targetId: s.targetId };
    },
    me,
    editable: (m) => ctl.editable(m),
    onRetryLoad: () => ctl.retry(),
    onSaveEdit: (id, text) => void saveEdit(id, text),
    onCancelEdit: () => composer.focus(),
    onDelete: (id) => void doDelete(id),
    onRetrySend: (id) => void ctl.retrySend(id),
    onDiscard: (id) => ctl.discard(id),
    fileUrl: api.fileUrl,
    refreshFileToken: () => api.fileToken(true),
    avatarUrl: api.avatarUrl,
    onMessageUser: (userId) => void messageUser(userId),
    signal,
  });
  const composer = createComposer({
    id: `${vid}-text`,
    onSend: (text, files) => ctl.send(text, files),
    onEditLast: () => {
      const mine = ctl.lastEditable();
      if (mine) messages.startEdit(mine.id);
      return !!mine;
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

  /** Put a controller change on screen. */
  function apply(c: Change) {
    const s = ctl.state();
    if (s.phase !== shown) {
      shown = s.phase;
      if (s.phase === "not-found") return renderNotFound();
      list.setAttribute("aria-busy", String(s.phase === "loading"));
      renderHeader();
      renderFooter();
    }
    if (c.notice !== undefined) notice.textContent = c.notice;
    pill.hidden = s.pill === null;
    pill.textContent = s.pill === "history" ? "New messages · Jump to latest" : "↓ New messages";
    if (c.render) render(c.render);
    if (c.scroll === "bottom") scrollToBottom();
    else if (c.scroll === "top") list.scrollTop = 0;
    else if (c.scroll === "target" && s.targetId) {
      const el = list.querySelector<HTMLElement>(`li.msg[data-id="${CSS.escape(s.targetId)}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2;
    }
  }

  /**
   * The newest messages are on screen (§18.3): loaded, scrolled to the bottom, in a visible tab. Scrolled up, a new
   * message only shows the pill, and stays unread until you scroll down to it.
   */
  const atLiveEdge = () => {
    const s = ctl.state();
    return s.phase === "ready" && !s.win.hasNewer && isNearBottom(list) && document.visibilityState !== "hidden";
  };

  /** The newest message the server has, if it is on screen. */
  function markRead() {
    if (!reader || !atLiveEdge()) return;
    const last = lastSaved(ctl.state().win);
    if (last) reader.seen(last.created);
  }

  function scrollToBottom() {
    list.scrollTop = list.scrollHeight;
    markRead();
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
    if (!r || shown === "failed") return footer.replaceChildren();
    if (r.archived) footer.replaceChildren(banner);
    else if (footer.firstChild !== composer.el) footer.replaceChildren(composer.el);
    composer.setPlaceholder(`Message ${roomTitle(r, me())}`);
  }

  function renderNotFound() {
    shell.replaceChildren(h("p", { class: "not-found" }, ["This room doesn't exist. ", h("a", { href: "#/" }, "Back to rooms")]));
  }

  // ---------------------------------------------------------------- edit / delete

  async function saveEdit(id: string, raw: string) {
    const m = ctl.find(id);
    const text = m ? validEdit(raw, !!m.files?.length) : null;
    if (text === null) return; // the edit box says what is wrong (messages.ts)
    messages.stopEdit();
    messages.setError(id, null);
    const saving = ctl.edit(id, text); // renders the new text right away
    if (!saving) render(); // nothing to save: just close the box
    composer.focus();
    if ((await saving) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    render({ anchor: true });
  }

  async function doDelete(id: string) {
    messages.setError(id, null);
    if ((await ctl.remove(id)) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    render({ anchor: true });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Single use: the router and the sidebar layout create a fresh view for every mount. */
  return {
    mount(el, params) {
      root = el;
      roomId = params.id!;
      ctl = createRoomController({
        api,
        store,
        roomId,
        msgId: params.msgId,
        scope,
        nearBottom: () => isNearBottom(list),
        onChange: apply,
      });

      pill.addEventListener(
        "click",
        () => {
          if (ctl.state().pill === "history") return void ctl.jump("latest");
          scrollToBottom();
          ctl.dismissPill();
        },
        { signal },
      );
      list.addEventListener("scroll", () => isNearBottom(list) && ctl.dismissPill(), { signal });
      document.addEventListener("visibilitychange", markRead, { signal });
      list.addEventListener("scroll", markRead, { signal });
      // When the list gets shorter (the attachment tray opens, the textarea grows, the keyboard opens) while it is
      // at the live bottom, keep it there instead of letting the newest messages slide under the composer (BUG-31).
      let pinned = true;
      list.addEventListener("scroll", () => (pinned = isNearBottom(list)), { signal });
      if (typeof ResizeObserver === "function") {
        const resizes = new ResizeObserver(() => {
          const s = ctl.state();
          if (pinned && s.phase === "ready" && !s.win.hasNewer) scrollToBottom();
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

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting || !list.contains(e.target)) continue;
            if (e.target === messages.topSentinel) void ctl.loadEdge("top");
            if (e.target === messages.bottomSentinel) void ctl.loadEdge("bottom");
          }
        },
        { root: list, rootMargin: "300px 0px" },
      );
      observer.observe(messages.topSentinel);
      observer.observe(messages.bottomSentinel);
      scope.defer(() => observer.disconnect());

      clear(root);
      root.append(shell);
      renderHeader();
      renderFooter();

      store.set({ activeRoomId: roomId });
      scope.defer(() => store.set({ activeRoomId: null }));
      const r = unread.open(roomId);
      reader = r;
      scope.defer(() => r.close(atLiveEdge()));
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
      ctl.start();
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
