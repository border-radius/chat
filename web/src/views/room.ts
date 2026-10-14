// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, replies (§19), reactions and
// the emoji picker (§20), selecting messages to forward or delete them (§21), archived mode, read state (§18.3).
// The message window and everything that changes it live in room/controller.ts (no DOM). This module puts the
// controller's changes on screen and wires the parts in room/: header (title + actions menu), messages (the list),
// composer, selection (the bar while selecting), reply, notice (the status line), names (who reacted), forward dialog,
// access dialog (§23.2). A guest reads an Open Air room without a composer (§23.3).

import { errorMessage, reasonOf } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { newer, older, PAGE_SIZE, withFiles } from "../lib/cursor.ts";
import { attachmentName, isMedia, isVideo } from "../lib/files.ts";
import { emptyForward, lastSaved } from "../lib/messages.ts";
import { isDm, otherMember, roomTitle } from "../lib/rooms.ts";
import { isNearBottom } from "../lib/scroll.ts";
import { formatFull, parsePb } from "../lib/time.ts";
import type { Message } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import { roomSections } from "../store.ts";
import { createEmojiPicker } from "../ui/emoji-picker.ts";
import type { RoomReader } from "../unread.ts";
import { createAccessDialog } from "./room/access.ts";
import { createComposer, validEdit } from "./room/composer.ts";
import { type Change, createRoomController, type Phase, type RoomController } from "./room/controller.ts";
import { createForwardDialog } from "./room/forward.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList } from "./room/messages.ts";
import { createNameLookup } from "./room/names.ts";
import { createNotice } from "./room/notice.ts";
import { reactionFocus } from "./room/reactions.ts";
import { createReply } from "./room/reply.ts";
import { createSelection } from "./room/selection.ts";

/**
 * Two changes as one: the later scroll and notice, and a render if either asked for one, keeping the anchor if either
 * did (content changed above what is on screen).
 */
export function mergeChanges(a: Change, b: Change): Change {
  const c = { ...a, ...b };
  if (a.render?.anchor) c.render = a.render;
  return c;
}

export function createRoomView({ api, store, unread, actions, navigate, reopen, drafts, cache }: Ctx): View {
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
  /** The messages the forward dialog is open for. */
  let forwarding: string[] = [];
  /** Put the caret in the composer as soon as it is shown: on entering the room (§22.5). */
  let focusComposer = true;

  const room = () => store.get().rooms.get(roomId);
  const me = () => store.get().user;

  // ---------------------------------------------------------------- parts

  /** One emoji picker for the composer and every message's reactions. */
  const picker = createEmojiPicker({ signal });
  const notice = createNotice(signal);
  const nameOf = createNameLookup({
    usersById: (ids, sig) => api.usersById(ids, sig),
    signedIn: () => !!me(),
    onFound: () => render({ anchor: true }),
    signal,
  });
  const header = createRoomHeader({
    titleId: `${vid}-title`,
    actions,
    avatarUrl: api.avatarUrl,
    onJumpToBeginning: () => void now(() => ctl.jump("first")),
    onAccess: () => {
      const r = room();
      if (r) accessDialog.open(r, r.created_by === me()?.id, me());
    },
    onClosed: () => navigate("/"),
    signal,
  });
  const accessDialog = createAccessDialog({
    searchUsers: (q, sig) => api.searchUsers(q, sig),
    avatarUrl: api.avatarUrl,
    onSave: async (visibility, members) => {
      try {
        await actions.setAccess(roomId, visibility, members);
        return null;
      } catch (e) {
        return `Couldn't save. ${errorMessage(e)}`;
      }
    },
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
      return {
        win: s.win,
        ready: s.phase === "ready",
        failed: s.phase === "failed",
        beginning: beginningLabel(),
        targetId: s.targetId,
        unreadId: s.unreadId,
        selected: selection.ids,
      };
    },
    me,
    editable: (m) => ctl.editable(m),
    deletable: (m) => ctl.deletable(m),
    repliable: (m) => ctl.repliable(m),
    onReply: (id) => reply.start(id),
    selectable: (m) => ctl.selectable(m),
    onSelect: (id) => selection.toggle(id),
    onForward: (id) => openForward([id]),
    reactable: (m) => ctl.reactable(m),
    reactions: (m) => ctl.reactions(m),
    onReact: (id, emoji, on) => void react(id, emoji, on),
    onPickReaction: (id, opener) => pickReaction(id, opener),
    nameOf,
    onOpenQuote: (id) => void now(() => ctl.goTo(id)),
    onRetryLoad: () => now(() => ctl.retry()),
    onSaveEdit: (id, text) => void saveEdit(id, text),
    onCancelEdit: () => composer.focus(),
    onDelete: (id) => void doDelete(id),
    onRetrySend: (id) => void now(() => ctl.retrySend(id)),
    onDiscard: (id) => now(() => ctl.discard(id)),
    fileUrl: api.fileUrl,
    refreshFileToken: () => api.fileToken(true),
    onOpenImage: (m, file, opener) => void viewImage(m, file, opener),
    avatarUrl: api.avatarUrl,
    onMessageUser: (userId) => void messageUser(userId),
    signal,
  });
  const composer = createComposer({
    id: `${vid}-text`,
    onSend: (text, files) => {
      if (!now(() => ctl.send(text, files, reply.to ?? undefined))) return false;
      reply.set(null);
      return true;
    },
    onEditLast: () => {
      const mine = ctl.lastEditable();
      if (mine) messages.startEdit(mine.id);
      return !!mine;
    },
    onCancelReply: () => reply.set(null),
    onEmoji: (opener, insert) => picker.open(opener, { label: "Insert emoji", onPick: insert, restoreFocus: () => composer.focus() }),
    // Kept as you type, so a reload doesn't lose it (§22.3).
    onChange: (text) => {
      if (roomId) drafts.set(roomId, text);
    },
    signal,
  });
  const forwardDialog = createForwardDialog({
    rooms: () => {
      const s = roomSections(store.get());
      return [...s.dms, ...s.rooms, ...s.hidden];
    },
    me,
    searchUsers: (q, sig) => api.searchUsers(q, sig),
    avatarUrl: api.avatarUrl,
    onPick: async (to) => {
      // Not those deleted since the dialog opened: one would fail the whole forward.
      const ids = forwarding.filter((id) => {
        const m = ctl.find(id);
        return !m || !(m.deleted || emptyForward(m));
      });
      if (!ids.length) return "Couldn't forward. A message was deleted.";
      try {
        const target = "room" in to ? to.room : await actions.openDm(to.user.id);
        const n = (await api.forward(ids, target.id)).length;
        if (!scope.active) return null;
        selection.end();
        if (target.id !== roomId) navigate(`/r/${target.id}`);
        else notice.flash(n === 1 ? "Message forwarded." : `${n} messages forwarded.`);
        return null;
      } catch (e) {
        return `Couldn't forward. ${reasonOf(e)}`;
      }
    },
    signal,
  });
  const list = messages.el;
  const pill = h("button", { type: "button", class: "new-messages", hidden: true });
  const footer = h("footer", { class: "room-footer" });
  const banner = h("p", { class: "archived-banner" }, "This room is archived. History is read-only.");
  const guestBanner = h("p", { class: "guest-banner" }, [
    "You're reading as a guest. ",
    h("a", { href: "/login" }, "Log in"),
    " or ",
    h("a", { href: "/signup" }, "sign up"),
    " to join the conversation.",
  ]);
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` }, [
    header.el,
    notice.el,
    h("div", { class: "room-body" }, [list, pill]),
    footer,
    picker.el,
    forwardDialog.el,
    accessDialog.el,
  ]);

  const reply = createReply({ find: (id) => ctl.find(id), repliable: (m) => ctl.repliable(m), composer });

  // ---------------------------------------------------------------- selecting (§21)

  const selection = createSelection({
    find: (id) => ctl.find(id),
    selectable: (m) => ctl.selectable(m),
    deletable: (m) => ctl.deletable(m),
    onStart: (id) => {
      picker.close();
      messages.focusIn(id, ["input.select"], true);
    },
    onChange: (list) => {
      renderFooter();
      if (list) render({ anchor: true });
    },
    focusComposer: () => composer.focus(),
    onForward: (ids) => openForward(ids),
    onDelete: (ids) => void deleteSelected(ids),
    notice,
    signal,
  });

  /** Render the list, then mark what it shows as read. */
  function render(o?: { anchor?: boolean }) {
    selection.prune();
    messages.render(o);
    markRead();
  }

  async function deleteSelected(ids: string[]) {
    const failed = await now(() => ctl.removeMany(ids));
    // Say why: network trouble, rate limiting or the server's reason (QA BUG-58).
    if (failed && scope.active) notice.say(`Couldn't delete those messages. ${reasonOf(failed)}`);
  }

  function openForward(ids: string[]) {
    if (!ids.length) return;
    forwarding = ids;
    picker.close();
    forwardDialog.open(ids.length);
  }

  /**
   * Changes are drawn at most once a frame. The first one is drawn right away (a message, a send or a click shows at
   * once); those that come in before the next frame are merged and drawn together in it. A burst of realtime events
   * then costs one render and one layout, not one each: every render ends by measuring the list (markRead,
   * renderPill), which makes the browser lay it out again.
   */
  let queued: Change | null = null;
  let frame = 0;
  /** Set while the user's own action runs: what it changes is drawn at once, never left for the next frame. */
  let direct = false;
  function apply(c: Change) {
    queued = queued ? mergeChanges(queued, c) : c;
    if (!frame || direct) flush();
  }

  /**
   * Draw what is queued, then keep merging until the next frame. Also called when the tab comes back: a hidden tab
   * has no frames.
   */
  function flush() {
    const q = queued;
    queued = null;
    if (!q || !scope.active) return;
    draw(q);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      flush();
    });
  }

  /** Run a controller call the user made (a click, a key): its changes show right away (see apply). */
  function now<T>(fn: () => T): T {
    direct = true;
    try {
      return fn();
    } finally {
      direct = false;
    }
  }

  /** Put a controller change on screen. */
  function draw(c: Change) {
    const s = ctl.state();
    if (s.phase !== shown) {
      shown = s.phase;
      if (s.phase === "not-found") return renderNotFound();
      list.setAttribute("aria-busy", String(s.phase === "loading"));
      renderHeader();
      renderFooter();
    }
    if (c.notice !== undefined) notice.say(c.notice);
    if (c.render) {
      render(c.render);
      reply.refresh();
    }
    if (c.scroll === "bottom") scrollToBottom();
    else if (c.scroll === "top") list.scrollTop = 0;
    else if (c.scroll === "target") {
      // A message gone to is centred; the first unread one goes near the top, with what follows it below.
      const id = s.targetId ?? s.unreadId;
      const el = id && list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / (s.targetId ? 2 : 4);
    }
    renderPill();
  }

  /**
   * The button over the bottom of the list: "New messages" when some arrived out of sight (§7.5), else "Jump to
   * latest" whenever the newest messages aren't on screen: scrolled up, or the window is back in history (§22.7).
   */
  function renderPill() {
    const s = ctl.state();
    const away = s.phase === "ready" && (s.win.hasNewer || !isNearBottom(list));
    pill.hidden = s.pill === null && !away;
    pill.classList.toggle("jump", s.pill === null);
    pill.textContent = s.pill === "history" ? "New messages · Jump to latest" : s.pill === "below" ? "↓ New messages" : "↓ Jump to latest";
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
      if (scope.active) navigate(`/r/${dm.id}`);
    } catch (e) {
      if (scope.active) notice.say(`Couldn't open that conversation. ${errorMessage(e)}`);
    }
  }

  /**
   * A thumbnail was clicked: show it in the viewer (§17.7) with the room's other images and videos, oldest first: the
   * window's to start with, the viewer fetches the others when it gets near them.
   * The viewer is a lazy chunk, loaded on the first click. If it can't be (offline, or a new version was deployed),
   * the image opens in a new tab, as a thumbnail did before the viewer.
   */
  async function viewImage(m: Message, file: string, opener: HTMLElement) {
    const media = (x: Message) => (x.files ?? []).filter(isMedia).map((f) => ({ message: x, file: f, video: isVideo(f) }));
    const { win } = ctl.state();
    const images = win.items.flatMap((x) => (x.deleted || x.localFiles?.length ? [] : media(x)));
    const id = roomId;
    const start = images.findIndex((i) => i.message.id === m.id && i.file === file);
    try {
      const { openViewer } = await import("./room/viewer.ts");
      if (!scope.active) return;
      await openViewer({
        images,
        start,
        more: [win.hasOlder, win.hasNewer],
        page: async (back, edge) => {
          const messages = await api.page(withFiles(back ? older(id, edge) : newer(id, edge)), signal);
          return { messages: back ? messages.reverse() : messages, done: messages.length < PAGE_SIZE };
        },
        media,
        h,
        name: attachmentName,
        when: (x) => formatFull(parsePb(x.created)),
        fileUrl: api.fileUrl,
        refreshFileToken: () => api.fileToken(true),
        opener,
        signal,
      });
    } catch {
      if (scope.active) window.open(api.fileUrl(m, file), "_blank", "noopener");
    }
  }

  function renderFooter() {
    const r = room();
    // No composer while the room failed to load: you'd be writing into history you can't see.
    // (The composer element, and anything typed into it, is kept for when the load succeeds.)
    if (!r || shown === "failed") return footer.replaceChildren();
    if (selection.ids) {
      // The composer (and anything typed into it) comes back when selecting ends.
      selection.refresh();
      if (footer.firstChild !== selection.bar) footer.replaceChildren(selection.bar);
      picker.close();
    } else if (r.archived) {
      footer.replaceChildren(banner);
      picker.close(); // nothing left to insert into or react to
    } else if (!me()) {
      if (footer.firstChild !== guestBanner) footer.replaceChildren(guestBanner);
    } else if (footer.firstChild !== composer.el) footer.replaceChildren(composer.el);
    composer.setPlaceholder(`Message ${roomTitle(r, me())}`);
    // Entering a room (or switching to another one), you can just type. Not on touch screens: it would pop up the
    // keyboard over the messages you came to read.
    if (focusComposer && footer.contains(composer.el)) {
      focusComposer = false;
      if (!matchMedia("(hover:none)").matches) composer.focus();
    }
  }

  /**
   * Shown "not found" or "gone": once the room is yours to see (again), the page starts over and shows it (§23.4, QA
   * BUG-60). Clicking it in the room list couldn't: it is the same URL.
   */
  let offReturn: (() => void) | null = null;
  function awaitReturn() {
    offReturn ??= store.subscribe((s, prev) => {
      if (s.rooms.has(roomId) && !prev.rooms.has(roomId) && s.user === prev.user) reopen();
    });
  }

  /** The page's heading says it, as a room's name would (QA BUG-90). */
  const notFound = (title: string, rest: (Node | string)[]) => h("div", { class: "not-found" }, [h("h1", {}, title), h("p", {}, rest)]);

  function renderNotFound() {
    awaitReturn();
    // A guest may have followed a link to a room that needs an account (§23.3).
    const why = me() ? [] : [h("a", { href: "/login" }, "Log in"), " to see more rooms, or "];
    const back = h("a", { href: "/" }, me() ? "Back to rooms" : "go back to the Open Air rooms");
    shell.replaceChildren(notFound("This room doesn't exist.", [...why, back]));
  }

  /**
   * The room went from the list while open (§23.4): you were taken out of a private room, or it is no longer open to
   * guests. What was on screen goes too.
   */
  function renderGone() {
    shown = "not-found";
    awaitReturn();
    picker.close();
    forwardDialog.close();
    accessDialog.close();
    const back = h("a", { href: "/" }, "Back to rooms");
    shell.replaceChildren(notFound("You can't see this room any more.", [back]));
    scope.dispose();
  }

  // ---------------------------------------------------------------- edit / delete

  async function saveEdit(id: string, raw: string) {
    const m = ctl.find(id);
    const text = m ? validEdit(raw, !!m.files?.length) : null;
    if (text === null) return; // the edit box says what is wrong (messages.ts)
    messages.stopEdit();
    messages.setError(id, null);
    const saving = now(() => ctl.edit(id, text)); // renders the new text right away
    if (!saving) render(); // nothing to save: just close the box
    composer.focus();
    if ((await saving) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    render({ anchor: true });
  }

  async function doDelete(id: string) {
    messages.setError(id, null);
    if ((await now(() => ctl.remove(id))) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    render({ anchor: true });
  }

  // ---------------------------------------------------------------- reactions

  /** Add or take back my reaction; focus stays on it (its message is redrawn). Failing, say so under the message. */
  async function react(id: string, emoji: string, on: boolean) {
    messages.setError(id, null);
    messages.focusIn(id, reactionFocus(emoji), true);
    const saving = now(() => ctl.react(id, emoji, on));
    if (!saving) return render({ anchor: true });
    if ((await saving) || !scope.active) return;
    messages.setError(id, {
      text: on ? `Couldn't add your ${emoji} reaction.` : `Couldn't remove your ${emoji} reaction.`,
      retry: () => void react(id, emoji, on),
    });
    render({ anchor: true });
  }

  /** The picker for a reaction to message `id`: picking an emoji I already reacted with takes it back. */
  function pickReaction(id: string, opener: HTMLElement) {
    const m = ctl.find(id);
    const user = me();
    if (!m || !user || !ctl.reactable(m)) return;
    const mine = new Set(ctl.reactions(m).flatMap((r) => (r.users.includes(user.id) ? [r.emoji] : [])));
    picker.open(opener, {
      label: "Add reaction",
      chosen: mine,
      onPick: (emoji) => void react(id, emoji, !mine.has(emoji)),
      restoreFocus: () => messages.focusIn(id, [".actions .react", ".reactions .add-reaction"]),
    });
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
        onUpload: (id, fraction) => messages.setUpload(id, fraction),
        cache,
      });

      pill.addEventListener(
        "click",
        () => {
          const s = ctl.state();
          if (s.pill === "history" || s.win.hasNewer) return void now(() => ctl.jump("latest"));
          scrollToBottom();
          ctl.dismissPill();
          renderPill();
        },
        { signal },
      );
      list.addEventListener("scroll", () => isNearBottom(list) && ctl.dismissPill(), { signal });
      list.addEventListener("scroll", renderPill, { signal });
      // Escape stops selecting (the forward dialog handles its own Escape).
      shell.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "Escape" || e.defaultPrevented || forwardDialog.el.open) return;
          if (selection.escape()) e.preventDefault();
        },
        { signal },
      );
      document.addEventListener(
        "visibilitychange",
        () => {
          flush();
          markRead();
        },
        { signal },
      );
      // Coming back to the window: put the caret in the composer so you can just type. Only when nothing else has
      // focus (or a link does, e.g. an attachment opened in a new tab): never away from a field, menu or confirm you
      // were on. Not with text selected (you may be copying it), and not on touch screens (it pops up the keyboard).
      window.addEventListener(
        "focus",
        () =>
          footer.contains(composer.el) &&
          document.activeElement!.matches("body,a") &&
          getSelection()!.isCollapsed &&
          !matchMedia("(hover:none)").matches &&
          composer.focus(),
        { signal },
      );
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
      // What you were writing here before visiting another room (QA BUG-50) or reloading the page (§22.3).
      composer.setText(drafts.get(roomId));

      store.set({ activeRoomId: roomId });
      scope.defer(() => store.set({ activeRoomId: null }));
      const r = unread.open(roomId);
      reader = r;
      // Left before the first page was in, the server may have more than the kept window showed: it says what is unread.
      scope.defer(() => r.close(atLiveEdge() && !ctl.state().stale));
      scope.defer(
        store.subscribe((s, prev) => {
          // Lost while you were in it (§23.4). Not on logging out: the views start over then anyway.
          if (prev.rooms.has(roomId) && !s.rooms.has(roomId) && s.user === prev.user && shown !== "not-found") return renderGone();
          const roomChanged = s.rooms.get(roomId) !== prev.rooms.get(roomId);
          if (roomChanged || s.hidden !== prev.hidden || s.user !== prev.user) {
            renderHeader();
            renderFooter();
            if (roomChanged) {
              render();
              reply.refresh(); // archived: the reply bar closes
            }
          }
        }),
      );
      ctl.start();
    },
    unmount() {
      offReturn?.();
      scope.dispose();
      clear(root);
    },
  };
}
