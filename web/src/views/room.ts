// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, replies (§19), reactions and
// the emoji picker (§20), selecting messages to forward or delete them (§21), archived mode, read state (§18.3).
// The message window and everything that changes it live in room/controller.ts (no DOM). This module puts the
// controller's changes on screen and wires the DOM parts in room/: header (title + actions menu), messages (the
// list), composer, forward dialog.

import { errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { MAX_SELECTED } from "../lib/limits.ts";
import { lastSaved, quoteText } from "../lib/messages.ts";
import { isDm, otherMember, roomTitle } from "../lib/rooms.ts";
import { isNearBottom } from "../lib/scroll.ts";
import type { Message } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import { roomSections } from "../store.ts";
import { createEmojiPicker } from "../ui/emoji-picker.ts";
import type { RoomReader } from "../unread.ts";
import { createComposer, validEdit } from "./room/composer.ts";
import { type Change, createRoomController, type Phase, type RoomController } from "./room/controller.ts";
import { createForwardDialog } from "./room/forward.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList, reactionFocus } from "./room/messages.ts";

/** How long a confirmation such as "Message forwarded." stays on screen (§22.6). */
export const NOTICE_MS = 4000;

export function createRoomView({ api, store, unread, actions, navigate, drafts }: Ctx): View {
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
  /** The message the composer is replying to (§19). */
  let replyTo: Message | null = null;
  /** The selected messages while selecting (§21.1), else null. */
  let selected: Set<string> | null = null;
  /** The selection bar asks "Delete these messages?". */
  let confirmingDelete = false;
  /** The messages the forward dialog is open for. */
  let forwarding: string[] = [];
  /** Put the caret in the composer as soon as it is shown: on entering the room (§22.5). */
  let focusComposer = true;

  const room = () => store.get().rooms.get(roomId);
  const me = () => store.get().user;

  // ---------------------------------------------------------------- parts

  /** One emoji picker for the composer and every message's reactions. */
  const picker = createEmojiPicker({ signal });
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
      return {
        win: s.win,
        ready: s.phase === "ready",
        failed: s.phase === "failed",
        beginning: beginningLabel(),
        targetId: s.targetId,
        selected,
      };
    },
    me,
    editable: (m) => ctl.editable(m),
    deletable: (m) => ctl.deletable(m),
    repliable: (m) => ctl.repliable(m),
    onReply: (id) => startReply(id),
    selectable: (m) => ctl.selectable(m),
    onSelect: (id) => select(id),
    onForward: (id) => openForward([id]),
    reactable: (m) => ctl.reactable(m),
    reactions: (m) => ctl.reactions(m),
    onReact: (id, emoji, on) => void react(id, emoji, on),
    onPickReaction: (id, opener) => pickReaction(id, opener),
    nameOf: (id) => nameOf(id),
    onOpenQuote: (id) => void ctl.goTo(id),
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
    onSend: (text, files) => {
      if (!ctl.send(text, files, replyTo ?? undefined)) return false;
      setReply(null);
      return true;
    },
    onEditLast: () => {
      const mine = ctl.lastEditable();
      if (mine) messages.startEdit(mine.id);
      return !!mine;
    },
    onCancelReply: () => setReply(null),
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
      try {
        const target = "room" in to ? to.room : await actions.openDm(to.user.id);
        const n = (await api.forward(forwarding, target.id)).length;
        if (!scope.active) return null;
        endSelect();
        if (target.id !== roomId) navigate(`#/r/${target.id}`);
        else flash(n === 1 ? "Message forwarded." : `${n} messages forwarded.`);
        return null;
      } catch (e) {
        return `Couldn't forward. ${errorMessage(e)}`;
      }
    },
    signal,
  });
  const list = messages.el;
  const pill = h("button", { type: "button", class: "new-messages", hidden: true });
  const footer = h("footer", { class: "room-footer" });
  const banner = h("p", { class: "archived-banner" }, "This room is archived. History is read-only.");
  const notice = h("p", { class: "room-notice", role: "status" });
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Show a confirmation that goes away by itself (§22.6), unless something else is said meanwhile. */
  function flash(text: string) {
    notice.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (notice.textContent === text) notice.textContent = "";
    }, NOTICE_MS);
  }
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` }, [
    header.el,
    notice,
    h("div", { class: "room-body" }, [list, pill]),
    footer,
    picker.el,
    forwardDialog.el,
  ]);

  // ---------------------------------------------------------------- selecting (§21)

  const selCount = h("span", { class: "sel-count", role: "status" });
  const selBar = h("div", { class: "selection-bar", role: "toolbar", "aria-label": "Selected messages" });
  const barBtn = (label: string, run: () => void, cls = "") =>
    h("button", { type: "button", class: cls, on: { click: run }, signal }, label);
  const forwardBtn = barBtn("Forward", () => openForward([...(selected ?? [])]), "primary");
  const deleteBtn = barBtn("Delete", () => setConfirmDelete(true), "danger");
  const selActions = [selCount, forwardBtn, deleteBtn, barBtn("Cancel", () => endSelect(true))];
  const confirmText = h("span");
  const confirmActions = [
    confirmText,
    barBtn("Delete", () => void deleteSelected(), "danger confirm-delete"),
    barBtn("Cancel", () => setConfirmDelete(false), "cancel"),
  ];

  /** Render the list, then mark what it shows as read. */
  function render(o?: { anchor?: boolean }) {
    pruneSelection();
    messages.render(o);
    markRead();
  }

  const LIMIT_NOTICE = `You can select up to ${MAX_SELECTED} messages at a time.`;

  /** Select or unselect message `id`; the first one starts selecting, unselecting the last one stops. */
  function select(id: string) {
    const m = ctl.find(id);
    if (!m || !ctl.selectable(m)) return;
    if (!selected) {
      selected = new Set();
      picker.close();
      messages.focusIn(id, ["input.select"], true);
    }
    if (selected.has(id)) selected.delete(id);
    else if (selected.size >= MAX_SELECTED) {
      notice.textContent = LIMIT_NOTICE;
      return;
    } else selected.add(id);
    confirmingDelete = false;
    if (!selected.size) return endSelect(true);
    renderFooter();
    render({ anchor: true });
  }

  /** Stop selecting; `focus`: put the caret back in the composer. */
  function endSelect(focus = false) {
    if (!selected) return;
    selected = null;
    confirmingDelete = false;
    if (notice.textContent === LIMIT_NOTICE) notice.textContent = "";
    renderFooter();
    render({ anchor: true });
    if (focus) composer.focus();
  }

  /** Selected messages that left the window, or can't be selected any more (deleted meanwhile), are unselected. */
  function pruneSelection() {
    if (!selected) return;
    for (const id of selected) {
      const m = ctl.find(id);
      if (!m || !ctl.selectable(m)) selected.delete(id);
    }
    if (selected.size) return updateBar();
    selected = null;
    renderFooter();
  }

  /** Deletable: every selected message is mine (and may still be deleted). */
  const allMine = () => !!selected?.size && [...selected].every((id) => ctl.deletable(ctl.find(id)!));

  function updateBar() {
    const n = selected?.size ?? 0;
    if (confirmingDelete && allMine()) {
      confirmText.textContent = n === 1 ? "Delete this message? " : `Delete these ${n} messages? `;
      if (selBar.firstChild !== confirmText) selBar.replaceChildren(...confirmActions);
      return;
    }
    confirmingDelete = false;
    selCount.textContent = `${n} selected`;
    deleteBtn.hidden = !allMine();
    if (selBar.firstChild !== selCount) selBar.replaceChildren(...selActions);
  }

  function setConfirmDelete(on: boolean) {
    confirmingDelete = on;
    updateBar();
    selBar.querySelector<HTMLElement>(on ? ".cancel" : ".danger")?.focus();
  }

  async function deleteSelected() {
    const ids = [...(selected ?? [])];
    endSelect(true);
    const failed = await ctl.removeMany(ids);
    // Say why: network trouble, rate limiting or the server's reason (QA BUG-58).
    if (failed && scope.active) notice.textContent = `Couldn't delete those messages. ${errorMessage(failed)}`;
  }

  function openForward(ids: string[]) {
    if (!ids.length) return;
    forwarding = ids;
    picker.close();
    forwardDialog.open(ids.length);
  }

  // ---------------------------------------------------------------- replies

  function setReply(m: Message | null) {
    replyTo = m;
    composer.setReply(m && { name: m.expand?.author?.name ?? "Unknown", text: quoteText(m) });
  }

  function startReply(id: string) {
    const m = ctl.find(id);
    if (!m || !ctl.repliable(m)) return;
    setReply(m);
    composer.focus();
  }

  /**
   * Follow the message being replied to: edited, it shows the new text; deleted (or the room archived), there is
   * nothing left to reply to. Out of the window, it is checked against the room alone.
   */
  function refreshReply() {
    if (!replyTo) return;
    const now = ctl.find(replyTo.id) ?? replyTo;
    if (!ctl.repliable(now)) setReply(null);
    else if (now !== replyTo) setReply(now);
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
    if (c.render) {
      render(c.render);
      refreshReply();
    }
    if (c.scroll === "bottom") scrollToBottom();
    else if (c.scroll === "top") list.scrollTop = 0;
    else if (c.scroll === "target" && s.targetId) {
      const el = list.querySelector<HTMLElement>(`li.msg[data-id="${CSS.escape(s.targetId)}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / 2;
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
    if (selected) {
      // The composer (and anything typed into it) comes back when selecting ends.
      updateBar();
      if (footer.firstChild !== selBar) footer.replaceChildren(selBar);
      picker.close();
    } else if (r.archived) {
      footer.replaceChildren(banner);
      picker.close(); // nothing left to insert into or react to
    } else if (footer.firstChild !== composer.el) footer.replaceChildren(composer.el);
    composer.setPlaceholder(`Message ${roomTitle(r, me())}`);
    // Entering a room (or switching to another one), you can just type. Not on touch screens: it would pop up the
    // keyboard over the messages you came to read.
    if (focusComposer && footer.contains(composer.el)) {
      focusComposer = false;
      if (!matchMedia("(hover:none)").matches) composer.focus();
    }
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

  // ---------------------------------------------------------------- reactions

  /** Add or take back my reaction; focus stays on it (its message is redrawn). Failing, say so under the message. */
  async function react(id: string, emoji: string, on: boolean) {
    messages.setError(id, null);
    messages.focusIn(id, reactionFocus(emoji), true);
    const saving = ctl.react(id, emoji, on);
    if (!saving) return render({ anchor: true });
    if ((await saving) || !scope.active) return;
    messages.setError(id, {
      text: on ? `Couldn't add your ${emoji} reaction.` : `Couldn't remove your ${emoji} reaction.`,
      retry: () => void react(id, emoji, on),
    });
    render({ anchor: true });
  }

  /** Names of people who reacted but aren't in the window, fetched in batches (§20.3). */
  const people = new Map<string, string>();
  /** Ids to look up, or being looked up. */
  const asking = new Set<string>();
  let lookingUp = false;

  function nameOf(id: string): string | undefined {
    const name = people.get(id);
    if (name !== undefined || asking.has(id)) return name;
    asking.add(id);
    if (!lookingUp) {
      lookingUp = true;
      queueMicrotask(() => void lookUpNames()); // one request for every name this render asks for
    }
    return undefined;
  }

  async function lookUpNames() {
    const ids = [...asking].filter((id) => !people.has(id)).slice(0, 50);
    let ok = true;
    try {
      const found = await api.usersById(ids, signal);
      for (const u of found) people.set(u.id, u.name);
      for (const id of ids) if (!people.has(id)) people.set(id, "Unknown"); // e.g. a deleted account
    } catch {
      ok = false;
      for (const id of ids) asking.delete(id); // asked again by the next render (not this one: no retry loop offline)
    }
    if (!scope.active || !ok) {
      lookingUp = false;
      return;
    }
    if ([...asking].some((id) => !people.has(id))) return void lookUpNames(); // more than 50
    lookingUp = false;
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
      });

      pill.addEventListener(
        "click",
        () => {
          const s = ctl.state();
          if (s.pill === "history" || s.win.hasNewer) return void ctl.jump("latest");
          scrollToBottom();
          ctl.dismissPill();
          renderPill();
        },
        { signal },
      );
      list.addEventListener("scroll", () => isNearBottom(list) && ctl.dismissPill(), { signal });
      list.addEventListener("scroll", renderPill, { signal });
      scope.defer(() => clearTimeout(noticeTimer));
      // Escape stops selecting (the forward dialog handles its own Escape).
      shell.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "Escape" || !selected || e.defaultPrevented || forwardDialog.el.open) return;
          e.preventDefault();
          if (confirmingDelete) setConfirmDelete(false);
          else endSelect(true);
        },
        { signal },
      );
      document.addEventListener("visibilitychange", markRead, { signal });
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
      scope.defer(() => r.close(atLiveEdge()));
      scope.defer(
        store.subscribe((s, prev) => {
          const roomChanged = s.rooms.get(roomId) !== prev.rooms.get(roomId);
          if (roomChanged || s.hidden !== prev.hidden || s.user !== prev.user) {
            renderHeader();
            renderFooter();
            if (roomChanged) {
              render();
              refreshReply(); // archived: the reply bar closes
            }
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
