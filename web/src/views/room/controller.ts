// Room controller (§7.5, §7.6): one room's message window and everything that changes it. That covers loading,
// realtime, reconnects, sending, edits, deletes, reactions (§20) and deleting several messages at once (§21). No DOM: every change is reported to `onChange` with a hint
// (render, keep the anchor, scroll), and the room view (views/room.ts) applies it to the list.

import { type Action, type Api, ApiError } from "../../api.ts";
import type { Cache } from "../../cache.ts";
import { type Cursor, changedIn, first, latest, newer, older, PAGE_SIZE } from "../../lib/cursor.ts";
import { newId } from "../../lib/id.ts";
import {
  applyPage,
  emptyWindow,
  lastOwnEditable,
  lastSaved,
  type MessageWindow,
  merge,
  type PageKind,
  quoteOf,
  remove,
  trim,
} from "../../lib/messages.ts";
import { setReaction } from "../../lib/reactions.ts";
import { parsePb, toPb } from "../../lib/time.ts";
import type { LocalFile, Message, Reaction, Room } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import { type AppState, type Store, UNCOUNTED, upsertRoom } from "../../store.ts";

/** "loading" until the first page is in; "failed" offers Retry; "not-found": no such room (or not yours). */
/** How long a message gone to (a quote, a link) stays highlighted; styles/app/messages.css fades it out over this time. */
export const HIGHLIGHT_MS = 3000;
/** How long the line over the first unread message shows; styles/app/messages.css fades it out before then. */
export const UNREAD_LINE_MS = 5000;

/**
 * Sends that failed after their room view had gone (another room was opened while they were on their way), by room.
 * The room's next view shows them as not sent, with Retry: otherwise what was written would be lost without a word, as
 * the composer and the draft were cleared on sending.
 */
const strays = new Map<string, Message[]>();

export type Phase = "loading" | "ready" | "failed" | "not-found";
/** "below": new messages under the viewport. "history": new messages, but the window isn't at the live edge. */
export type Pill = "below" | "history" | null;

export interface RoomState {
  win: MessageWindow;
  phase: Phase;
  /** The message the route asked for, once it is in the window (highlighted). */
  targetId: string | null;
  /** The first message that was unread when the room was opened (§18.5): a line over it, for UNREAD_LINE_MS. */
  unreadId: string | null;
  pill: Pill;
  /** Showing the room as it was last time (cache.ts) until its first page is in: there may be newer messages. */
  stale: boolean;
}

/** What a change asks of the view. Pill and phase are read from `state()`, and every change may have changed them. */
export interface Change {
  /** The window changed. `anchor`: keep what is on screen in place (content changed above it). */
  render?: { anchor?: boolean };
  /** "target": bring `targetId` (else `unreadId`) into view. */
  scroll?: "bottom" | "top" | "target";
  /** Replace the notice above the list ("" clears it). */
  notice?: string;
}

export interface RoomController {
  state(): RoomState;
  /** Subscribe and run the first load. Everything ends with the scope. */
  start(): void;
  /** Retry a failed first load. */
  retry(): void;
  /** Extend the window at one end (a sentinel came into view). One request per end at a time. */
  loadEdge(side: "top" | "bottom"): Promise<void>;
  /** Reset the window to the latest page or the first page. */
  jump(kind: "latest" | "first"): Promise<void>;
  /** Highlight and centre message `id` (a reply's quote, §19), loading the history around it when needed. */
  goTo(id: string): Promise<void>;
  /** The user is at the bottom now: hide a "new messages below" pill. */
  dismissPill(): void;
  find(id: string): Message | undefined;
  /** Can I edit this message right now? Not a forward: its words are someone else's (§21.3). */
  editable(m: Message): boolean;
  /** Can I delete this message right now? */
  deletable(m: Message): boolean;
  /** Can I reply to this message right now? (§19) */
  repliable(m: Message): boolean;
  /** My newest editable message (Up arrow in an empty composer). */
  lastEditable(): Message | undefined;
  /** Send optimistically, as a reply to `replyTo` if given (§19). False when sending isn't possible (no user, archived room). */
  send(text: string, files?: LocalFile[], replyTo?: Message): boolean;
  retrySend(id: string): Promise<void>;
  /** Drop a failed message (no request). */
  discard(id: string): void;
  /** Save validated text. null: nothing to save (unchanged, or no longer editable). Resolves false if the save failed. */
  edit(id: string, text: string): Promise<boolean> | null;
  /** Soft delete. null: not in the window. Resolves false if the delete failed. */
  remove(id: string): Promise<boolean> | null;
  /** Can this message be selected, to forward (or delete) it with others? Saved and not deleted (§21). */
  selectable(m: Message): boolean;
  /**
   * Soft-delete several messages in one request, all or none (§21.2). null: none of them deletable. Resolves to why it
   * failed (the error), or null once they are deleted.
   */
  removeMany(ids: readonly string[]): Promise<unknown> | null;
  /** Can I react to this message right now? (§20) */
  reactable(m: Message): boolean;
  /** A message's reactions as they should show: the server's, with my changes still on their way applied. */
  reactions(m: Message): readonly Reaction[];
  /**
   * Add (`on`) or remove my `emoji` reaction, shown at once. null: not possible (not in the window, not reactable).
   * Resolves false if it failed (the reaction then shows as it was).
   */
  react(id: string, emoji: string, on: boolean): Promise<boolean> | null;
}

export function createRoomController(opts: {
  api: Api;
  store: Store<AppState>;
  roomId: string;
  /** /r/:id/m/:msgId */
  msgId?: string | undefined;
  scope: Scope;
  /** Is the list scrolled to (near) the bottom? New messages are followed only then. */
  nearBottom: () => boolean;
  onChange: (change: Change) => void;
  /** A sending message's attachments are this far uploaded, 0 to 1 (§17.4). */
  onUpload?: (id: string, fraction: number) => void;
  /** Where the room's latest messages are kept between visits (§7.5). */
  cache?: Cache;
}): RoomController {
  const { api, store, roomId, msgId, scope, nearBottom } = opts;
  const { signal } = scope;

  let win: MessageWindow = emptyWindow();
  let phase: Phase = "loading";
  let targetId: string | null = null;
  let targetTimer: ReturnType<typeof setTimeout> | undefined;
  let unreadId: string | null = null;
  let pill: Pill = null;
  /** The window is the one kept from last time (cache.ts), until the first page replaces it. */
  let stale = false;
  /** An end the list asked to extend while stale: extended once the first page is in. */
  let wanted: "top" | "bottom" | null = null;
  let keepTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  /** Realtime events that arrive before the first page (even while a stale window shows); replayed once it is in. */
  let buffer: [Action, Message][] = [];
  /**
   * Unsent (pending or failed) messages the window dropped, e.g. when a reply's quote took it back in history (§19).
   * They belong after the newest messages, so they come back once the window is at the live edge again.
   */
  const unsent = new Map<string, Message>();
  const loading = { top: false, bottom: false };
  /** The room's realtime subscription, set up by start(); "ready" once the server has it. */
  let live: Promise<unknown> = Promise.resolve();
  let liveReady = false;

  const ready = () => phase === "ready";
  const room = (): Room | undefined => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  /** Whom the window was loaded for: after a logout or a user switch, nothing of it may be kept for the next one. */
  const owner = me()?.id ?? "";
  const find = (id: string) => win.items.find((m) => m.id === id);
  const deletable = (m: Message) => {
    const r = room();
    return !!r && !r.archived && m.author === me()?.id && !m.deleted && !m.status;
  };
  const editable = (m: Message) => deletable(m) && !m.forwarded_from;
  /** Guests only read (§23.3): no replies, reactions or selecting. */
  const repliable = (m: Message) => {
    const r = room();
    return !!me() && !!r && !r.archived && !m.deleted && !m.status;
  };
  /**
   * My reaction changes still on their way, by message id and emoji: whether it should be there, and which change said
   * so last. They show over every copy of the message until that change is answered (§20.3).
   */
  const reacting = new Map<string, Map<string, { on: boolean; seq: number }>>();
  /**
   * Writes go one at a time, so the server applies them in the order they were made: sends (key ""), and each message's
   * edits, deletes and reactions (key: its id). Two at once can land the other way round: a message with an attachment
   * after the text sent just after it, or an older edit over a newer one.
   */
  const queues = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, write: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(write);
    const done = run.catch(() => {});
    queues.set(key, done);
    void done.then(() => queues.get(key) === done && queues.delete(key));
    return run;
  };
  let reactSeq = 0;
  const emit = (change: Change = {}) => {
    if (!scope.active) return;
    opts.onChange(change);
    clearTimeout(keepTimer);
    keepTimer = setTimeout(keep, 1000);
  };
  /** Keep the latest page for next time: only a fresh window at the live edge, only for whom it was loaded for. */
  const keep = () => {
    if (stale || !ready() || win.hasNewer || (me()?.id ?? "") !== owner) return;
    const saved = win.items.filter((m) => !m.status);
    const items = saved.slice(-PAGE_SIZE);
    opts.cache?.put(owner, roomId, { items, hasOlder: win.hasOlder || items.length < saved.length });
  };
  /** Local optimistic change that must win regardless of `updated` (edit/delete/revert). */
  const patchLocal = (id: string, patch: Partial<Message>) => {
    win = { ...win, items: win.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
  };
  /**
   * Replace the window by one that may have dropped messages (a jump, a page that trimmed the other end). Unsent
   * messages it dropped are kept aside, and put back once the window is at the live edge.
   */
  const setWin = (next: MessageWindow) => {
    const kept = new Set(next.items.map((m) => m.id));
    for (const m of win.items) if (m.status && !kept.has(m.id)) unsent.set(m.id, m);
    win = next;
    if (win.hasNewer || !unsent.size) return;
    win = merge(win, [...unsent.values()]);
    unsent.clear();
  };
  /** Highlight message `id` (or nothing) for HIGHLIGHT_MS: long enough to spot it, then it fades (styles/app/messages.css). */
  const setTarget = (id: string | null) => {
    targetId = id;
    clearTimeout(targetTimer);
    if (!id) return;
    targetTimer = setTimeout(() => {
      if (targetId !== id) return;
      targetId = null;
      emit({ render: { anchor: true } });
    }, HIGHLIGHT_MS);
  };
  /** Show the line over message `id` (§18.5) until UNREAD_LINE_MS from now. */
  const setUnread = (id?: string) => {
    if (!id || id === unreadId) return;
    unreadId = id;
    setTimeout(() => {
      if (unreadId !== id) return;
      unreadId = null;
      emit({ render: { anchor: true } });
    }, UNREAD_LINE_MS);
  };
  /** Release a local message's preview URLs (sent, discarded, or the room is going away). */
  const revokeLocal = (m: Message | undefined) => {
    for (const f of m?.localFiles ?? []) if (f.url) URL.revokeObjectURL(f.url);
  };

  // ---------------------------------------------------------------- loading

  /** Apply a page fetched under generation `g`, unless a jump (or the end of the scope) has made it stale. */
  function applyLoaded(kind: PageKind, page: Message[], g: number): boolean {
    if (g !== gen || !scope.active) return false;
    setWin(applyPage(win, page, kind).win);
    return true;
  }

  async function loadEdge(side: "top" | "bottom") {
    const more = side === "top" ? win.hasOlder : win.hasNewer;
    if (stale) wanted = side; // the window is about to be replaced: what it would load now could be out of date
    if (!ready() || stale || !more || loading[side] || !win.items.length) return;
    loading[side] = true;
    const g = gen;
    try {
      const page =
        side === "top" ? await api.page(older(roomId, win.items[0]!), signal) : await api.page(newer(roomId, win.items.at(-1)!), signal);
      if (applyLoaded(side === "top" ? "older" : "newer", page, g)) emit({ render: { anchor: true } });
    } catch {
      /* the sentinel will trigger again */
    } finally {
      if (g === gen) loading[side] = false;
    }
  }

  async function jump(kind: "latest" | "first") {
    const g = ++gen;
    loading.top = loading.bottom = false;
    pill = null;
    emit();
    const page = await api.page(kind === "latest" ? latest(roomId) : first(roomId), signal).catch(() => null);
    if (!page || !applyLoaded(kind, page, g)) return;
    setTarget(null);
    emit({ render: {}, notice: "", scroll: kind === "latest" ? "bottom" : "top" });
  }

  async function goTo(id: string) {
    const m = find(id);
    if (m && !m.status) {
      setTarget(id);
      return emit({ render: {}, scroll: "target", notice: "" });
    }
    // The current window stays until the new one is in; a jump meanwhile wins.
    const g = gen;
    const around = await windowAround(id).catch(() => undefined);
    if (g !== gen || !scope.active) return;
    if (!around) {
      return emit({
        notice: around === null ? "That message isn't available any more." : "Couldn't load that message. Check your connection.",
      });
    }
    gen++; // pages requested for the old window are stale now
    loading.top = loading.bottom = false;
    setWin(around.win);
    setTarget(around.target);
    pill = null;
    emit({ render: {}, scroll: "target", notice: "" });
  }

  /** The window around message `id`, or null when it isn't in this room. Rejects if a page fails. */
  async function windowAround(id: string): Promise<{ win: MessageWindow; target: string } | null> {
    // A missing message falls back to the latest page; any other failure fails the load (and offers Retry).
    const target = await api.getMessage(id, signal).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    if (!target || target.room !== roomId) return null;
    return { win: await windowAt(target), target: target.id };
  }

  /** The page before message `c`, and `c` with the page after it. */
  async function windowAt(c: Cursor): Promise<MessageWindow> {
    const [before, after] = await Promise.all([api.page(older(roomId, c), signal), api.page(newer(roomId, { ...c, id: "" }), signal)]);
    return merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [...before, ...after]);
  }

  async function open() {
    const g = ++gen;
    const roomP = api.getRoom(roomId, signal).then((r) => store.set(upsertRoom(r)));
    // Attachment URLs need a file token: have one before the first render, so images don't fail first.
    const tokenP = api.fileToken().catch(() => "");
    // With unread messages (the room list showed a badge), the room opens at the first of them (§18.5). Before the
    // counts are in (a reload), only the server knows.
    const { unread } = store.get();
    const firstP =
      msgId || !me() || (unread !== UNCOUNTED && !unread.get(roomId)) ? null : api.firstUnread(roomId, signal).catch(() => null);
    // Loaders only return a window; it is committed below, and only if nothing (a jump) replaced it meanwhile.
    const pageP = (async (): Promise<{ win: MessageWindow; target: string | null; unread?: string }> => {
      const around = msgId ? await windowAround(msgId) : null;
      if (around) return around;
      const f = firstP && (await firstP); // no await without one: the latest page is asked for at once
      if (f?.id) return { win: await windowAt(f), target: null, unread: f.id };
      return { win: applyPage(emptyWindow(), await api.page(latest(roomId), signal), "latest").win, target: null };
    })();
    pageP.catch(() => {}); // handled below; but we may return early (room not found) without awaiting it
    if (!msgId) void showKept(g, roomP, tokenP, firstP);
    try {
      await roomP;
    } catch (e) {
      if (!scope.active) return;
      phase = e instanceof ApiError && e.status === 404 ? "not-found" : "failed";
      stale = false;
      return emit({ render: {} });
    }
    const loaded = await pageP.catch(() => null);
    await tokenP;
    if (!scope.active) return;
    const current = g === gen;
    // Never show a failed load as an empty room ("Beginning of #room"): say so and offer Retry.
    if (current && !loaded) {
      phase = "failed";
      stale = false;
      return emit({ render: {} });
    }
    const change: Change = { render: {} };
    if (current && loaded) {
      setWin(loaded.win); // keeps a message sent (or adopted) while loading
      setTarget(loaded.target);
      setUnread(loaded.unread);
      change.notice = msgId && !loaded.target ? "That message isn't in this room. Showing the latest messages instead." : "";
      // Otherwise the jump has positioned the list. A stale window was already shown at the first unread message, or
      // you scrolled it: stay there (QA BUG-96), unless it was at the bottom and there is nothing unread.
      if (targetId || !stale) change.scroll = targetId || loaded.unread ? "target" : "bottom";
      else if (nearBottom() && !loaded.unread) change.scroll = "bottom";
      else change.render = { anchor: true };
    }
    // Ready either way: a jump made during the load already owns the window, but still needs the view live.
    phase = "ready";
    stale = false;
    emit(change);
    if (wanted) void loadEdge(wanted);
    const pending = buffer;
    buffer = [];
    for (const [action, m] of pending) onMessage(action, m);
    // The page and the subscription are set up side by side. A message sent after the page was read but before the
    // server had the subscription reaches neither (QA BUG-61): once the subscription is there, fetch what is newer.
    if (!liveReady) void live.then(catchUp);
  }

  /** Show the room as it was last time while its first page loads, if that is still to come. */
  async function showKept(g: number, roomP: Promise<unknown>, token: Promise<unknown>, firstP: Promise<Cursor | null> | null) {
    const kept = await opts.cache?.get(owner, roomId);
    await token; // attachment URLs need it, as for the first page
    if (!room()) await roomP.catch(() => {}); // just after a reload, the room list may not be in yet
    // Opening at the first unread message: only if it was kept too (no jump once the first page is in).
    const f = (await firstP)?.id;
    if (!kept?.items.length || g !== gen || phase !== "loading" || !room() || !scope.active) return;
    if (f && !kept.items.some((m) => m.id === f)) return;
    setWin(merge({ items: [], hasOlder: kept.hasOlder, hasNewer: false }, kept.items));
    setUnread(f);
    stale = true;
    phase = "ready";
    emit({ render: {}, scroll: f ? "target" : "bottom" });
  }

  /** Messages newer than the window's that realtime may have missed while it was being set up (QA BUG-61). */
  async function catchUp() {
    if (!scope.active || !ready() || win.hasNewer) return;
    const g = gen;
    const last = lastSaved(win);
    const page = await api.page(last ? newer(roomId, last) : latest(roomId), signal).catch(() => null);
    if (!page || g !== gen || !scope.active || win.hasNewer) return;
    const missed = page.filter((m) => !find(m.id));
    if (!missed.length) return;
    const follow = nearBottom();
    setWin(applyPage(win, page, last ? "newer" : "latest").win);
    if (!follow) pill = "below";
    emit(follow ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  function retry() {
    if (phase !== "failed" || !scope.active) return;
    phase = "loading";
    emit({ render: {} });
    void open();
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
    emit({ render: { anchor: true } });
  }

  /** At the live edge after a reconnect: fetch everything newer than what we have (§7.5). */
  async function gapFill() {
    const g = gen;
    const wasNear = nearBottom();
    for (;;) {
      const last = lastSaved(win);
      const page = await api.page(last ? newer(roomId, last) : latest(roomId), signal).catch(() => null);
      if (!page || g !== gen || !scope.active) return;
      setWin(applyPage(win, page, last ? "newer" : "latest").win);
      if (page.length < PAGE_SIZE) break;
    }
    setWin({ ...win, hasNewer: false });
    emit(wasNear ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  function onReconnect() {
    if (!scope.active) return;
    if (phase === "failed") return retry(); // back online: try the first load again
    if (!ready()) return;
    void refreshWindow();
    if (!win.hasNewer) void gapFill();
  }

  // ---------------------------------------------------------------- realtime

  function onMessage(action: Action, m: Message) {
    if (!scope.active || m.room !== roomId) return;
    if (!ready() || stale) buffer.push([action, m]); // the first page may be older than this event
    if (!ready()) return;
    if (action === "delete") {
      win = remove(win, m.id);
      return emit({ render: { anchor: true } });
    }
    if (action === "update") {
      if (!find(m.id)) return;
      win = merge(win, [m]);
      return emit({ render: { anchor: true } });
    }
    // create
    if (find(m.id)) {
      win = merge(win, [m]);
      return emit({ render: {} });
    }
    if (win.hasNewer) {
      pill = "history";
      return emit();
    }
    const follow = nearBottom() || m.author === me()?.id;
    win = trim(merge(win, [m]), "top").win;
    if (!follow && pill !== "history") pill = "below";
    emit(follow ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  // ---------------------------------------------------------------- sending

  function send(text: string, files: LocalFile[] = [], replyTo?: Message): boolean {
    const user = me();
    const r = room();
    if (!user || !r || r.archived) return false;
    const quoted = replyTo ? quoteOf(replyTo) : undefined;
    void (async () => {
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
        expand: { author: { id: user.id, name: user.name, avatar: user.avatar ?? "" }, ...(quoted ? { reply_to: quoted } : {}) },
        ...(quoted ? { reply_to: quoted.id } : {}),
        status: "pending",
        ...(files.length ? { localFiles: files } : {}),
      };
      win = trim(merge(win, [msg]), "top").win;
      pill = null;
      emit({ render: {}, scroll: "bottom" });
      await inTurn("", () => deliver(msg));
    })();
    return true;
  }

  async function deliver(msg: Message) {
    // A reply whose original has been deleted meanwhile can only go without its quote (§19): Retry sends it so.
    const quoted = msg.expand?.reply_to;
    const replyTo = msg.reply_to && !(find(msg.reply_to) ?? quoted)?.deleted ? msg.reply_to : undefined;
    let saved: Message | null = null;
    let failed: Message | null = null;
    try {
      const files = msg.localFiles?.map((f) => f.file);
      saved = await api.send(
        {
          id: msg.id,
          room: msg.room,
          text: msg.text,
          ...(files?.length ? { files } : {}),
          ...(replyTo ? { replyTo } : {}),
        },
        (fraction) => opts.onUpload?.(msg.id, fraction),
      );
    } catch (e) {
      // A retry of a send that already reached the server fails with a duplicate id: it was sent after all.
      const recovered = e instanceof ApiError && e.status === 400 ? await api.getMessage(msg.id).catch(() => null) : null;
      if (recovered && recovered.author === me()?.id) saved = recovered;
      else {
        const replyGone = e instanceof ApiError && "reply_to" in e.fields && quoted;
        failed = {
          ...msg,
          status: "failed",
          ...(replyGone ? { expand: { ...msg.expand, reply_to: { ...quoted, text: "", deleted: true } } } : {}),
        };
        // The server says the original is deleted, though the window may not have heard yet.
        if (replyGone && find(quoted.id)) patchLocal(quoted.id, { text: "", deleted: true });
      }
    }
    // The server has the files now: the previews can go, even if the room was left meanwhile (its echo may already have
    // replaced the pending copy, whose previews nothing else would release; QA BUG-70).
    if (saved) revokeLocal(msg);
    if (!scope.active) {
      // Its previews went with the view: its files show by name.
      const files = failed?.localFiles?.map((f) => ({ file: f.file, url: "" }));
      if (failed) strays.set(roomId, [...(strays.get(roomId) ?? []), { ...failed, ...(files && { localFiles: files }) }]);
      return;
    }
    // The window may have moved back in history meanwhile (a quote, a jump): then the message isn't in it, and
    // must not be put after older messages. Sent, it shows once the window is back at the live edge.
    if (saved) {
      unsent.delete(msg.id);
      if (find(msg.id)) win = merge(win, [saved]);
    } else if (failed && find(msg.id)?.status) win = merge(win, [failed]);
    else if (failed && unsent.has(msg.id)) unsent.set(msg.id, failed);
    emit({ render: {} });
  }

  async function retrySend(id: string) {
    const m = find(id);
    if (m?.status !== "failed") return;
    patchLocal(id, { status: "pending" });
    emit({ render: {} });
    await inTurn("", () => deliver({ ...m, status: "pending" }));
  }

  function discard(id: string) {
    revokeLocal(find(id));
    win = remove(win, id);
    emit({ render: {} });
  }

  // ---------------------------------------------------------------- edit / delete

  /** Show `patch` right away; keep the server's copy, or put `before` back if the request fails. */
  async function optimistic(id: string, patch: Partial<Message>, before: Partial<Message>, request: () => Promise<Message>) {
    patchLocal(id, patch);
    emit({ render: { anchor: true } });
    let ok = true;
    try {
      const saved = await inTurn(id, request);
      if (scope.active) win = merge(win, [saved]);
    } catch {
      if (!scope.active) return false;
      patchLocal(id, before);
      ok = false;
    }
    emit({ render: { anchor: true } });
    return ok;
  }

  function edit(id: string, text: string) {
    const m = find(id);
    // Deleted elsewhere or the room was archived while the edit box was open: nothing left to save.
    if (!m || !editable(m) || text === m.text) return null;
    return optimistic(id, { text }, { text: m.text, edited_at: m.edited_at }, () => api.edit(id, text));
  }

  function removeMessage(id: string) {
    const m = find(id);
    if (!m) return null;
    return optimistic(id, { text: "", deleted: true }, { text: m.text, deleted: false }, () => api.softDelete(id));
  }

  function removeMany(ids: readonly string[]) {
    const ms = ids.flatMap((id) => {
      const m = find(id);
      return m && deletable(m) ? [m] : [];
    });
    return ms.length ? deleteAll(ms) : null;
  }

  async function deleteAll(ms: Message[]): Promise<unknown> {
    for (const m of ms) patchLocal(m.id, { text: "", deleted: true });
    emit({ render: { anchor: true } });
    let failure: unknown = null;
    try {
      const saved = await api.deleteMany(ms.map((m) => m.id));
      if (scope.active)
        win = merge(
          win,
          saved.filter((m) => find(m.id)),
        );
    } catch (e) {
      if (!scope.active) return e;
      for (const m of ms) patchLocal(m.id, { text: m.text, deleted: false });
      failure = e;
    }
    emit({ render: { anchor: true } });
    return failure;
  }

  // ---------------------------------------------------------------- reactions

  function reactionsOf(m: Message): readonly Reaction[] {
    let list: readonly Reaction[] = m.reactions ?? [];
    const mine = reacting.get(m.id);
    const user = me()?.id;
    if (mine && user) for (const [emoji, p] of mine) list = setReaction(list, emoji, user, p.on);
    return list;
  }

  async function react(id: string, emoji: string, on: boolean): Promise<boolean> {
    const seq = ++reactSeq;
    const mine = reacting.get(id) ?? new Map();
    const latest = () => mine.get(emoji)?.seq === seq;
    const request = async () => {
      if (!latest()) return true; // changed again before it went out: the later change says what to send
      try {
        const saved = await api.react(id, emoji, on);
        // The whole message comes back: kept like any other copy (the newest wins).
        if (scope.active && find(id)) win = merge(win, [saved]);
        return true;
      } catch {
        return false;
      }
    };
    const queue = inTurn(id, request);
    reacting.set(id, mine.set(emoji, { on, seq }));
    emit({ render: { anchor: true } });
    const ok = await queue;
    // Changed again meanwhile: the later change shows, and says whether it worked.
    if (!latest()) return true;
    if (!scope.active) return ok;
    mine.delete(emoji);
    if (!mine.size && reacting.get(id) === mine) reacting.delete(id);
    emit({ render: { anchor: true } });
    return ok;
  }

  // ---------------------------------------------------------------- lifecycle

  return {
    state: () => ({ win, phase, targetId, unreadId, pill, stale }),
    start() {
      scope.defer(() => {
        clearTimeout(keepTimer);
        keep();
        for (const m of [...win.items, ...unsent.values()]) revokeLocal(m);
      });
      // Keep a fresh file token for attachment URLs (§17.3); it only fetches when the cached one is old.
      const keepToken = setInterval(() => void api.fileToken().catch(() => {}), 30_000);
      scope.defer(() => clearInterval(keepToken));
      scope.defer(() => clearTimeout(targetTimer));
      for (const m of strays.get(roomId) ?? []) if (m.author === me()?.id) unsent.set(m.id, m); // not from before a logout
      strays.delete(roomId);
      // Room record changes (archive etc.) arrive through the store, kept live by sync.ts.
      const sub = api.subscribeMessages(roomId, onMessage);
      scope.sub(sub);
      live = sub.then(
        () => (liveReady = true),
        () => {},
      );
      scope.defer(api.onConnect((reconnect) => reconnect && onReconnect()));
      void open();
    },
    retry,
    loadEdge,
    jump,
    goTo,
    dismissPill() {
      if (pill !== "below") return;
      pill = null;
      emit();
    },
    find,
    editable,
    deletable,
    repliable,
    lastEditable() {
      const mine = lastOwnEditable(win, me()?.id ?? "");
      return mine && editable(mine) ? mine : undefined;
    },
    send,
    retrySend,
    discard,
    edit,
    remove: removeMessage,
    selectable: (m) => !!me() && !m.deleted && !m.status,
    removeMany,
    reactable: repliable,
    reactions: reactionsOf,
    react(id, emoji, on) {
      const m = find(id);
      return m && repliable(m) && me() ? react(id, emoji, on) : null;
    },
  };
}
