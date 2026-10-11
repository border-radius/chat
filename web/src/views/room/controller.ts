// Room controller (§7.5, §7.6): one room's message window and everything that changes it. That covers loading,
// realtime, reconnects, sending, edits, deletes and reactions (§20). No DOM: every change is reported to `onChange` with a hint
// (render, keep the anchor, scroll), and the room view (views/room.ts) applies it to the list.

import { type Action, type Api, ApiError } from "../../api.ts";
import { changedIn, first, latest, newer, older, PAGE_SIZE } from "../../lib/cursor.ts";
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
import { type AppState, type Store, upsertRoom } from "../../store.ts";

/** "loading" until the first page is in; "failed" offers Retry; "not-found": no such room (or not yours). */
/** How long a message gone to (a quote, a link) stays highlighted; app.css fades it out over this time. */
export const HIGHLIGHT_MS = 3000;

export type Phase = "loading" | "ready" | "failed" | "not-found";
/** "below": new messages under the viewport. "history": new messages, but the window isn't at the live edge. */
export type Pill = "below" | "history" | null;

export interface RoomState {
  win: MessageWindow;
  phase: Phase;
  /** The message the route asked for, once it is in the window (highlighted). */
  targetId: string | null;
  pill: Pill;
}

/** What a change asks of the view. Pill and phase are read from `state()`, and every change may have changed them. */
export interface Change {
  /** The window changed. `anchor`: keep what is on screen in place (content changed above it). */
  render?: { anchor?: boolean };
  /** "target": centre `targetId`. */
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
  /** Can I edit or delete this message right now? */
  editable(m: Message): boolean;
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
  /** #/r/:id/m/:msgId */
  msgId?: string | undefined;
  scope: Scope;
  /** Is the list scrolled to (near) the bottom? New messages are followed only then. */
  nearBottom: () => boolean;
  onChange: (change: Change) => void;
}): RoomController {
  const { api, store, roomId, msgId, scope, nearBottom } = opts;
  const { signal } = scope;

  let win: MessageWindow = emptyWindow();
  let phase: Phase = "loading";
  let targetId: string | null = null;
  let targetTimer: ReturnType<typeof setTimeout> | undefined;
  let pill: Pill = null;
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  /** Realtime events that arrive before the first page; replayed once it is in. */
  let buffer: [Action, Message][] = [];
  /**
   * Unsent (pending or failed) messages the window dropped, e.g. when a reply's quote took it back in history (§19).
   * They belong after the newest messages, so they come back once the window is at the live edge again.
   */
  const unsent = new Map<string, Message>();
  const loading = { top: false, bottom: false };

  const ready = () => phase === "ready";
  const room = (): Room | undefined => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  const find = (id: string) => win.items.find((m) => m.id === id);
  const editable = (m: Message) => {
    const r = room();
    return !!r && !r.archived && m.author === me()?.id && !m.deleted && !m.status;
  };
  const repliable = (m: Message) => {
    const r = room();
    return !!r && !r.archived && !m.deleted && !m.status;
  };
  /**
   * My reaction changes still on their way, by message id and emoji: whether it should be there, and which change said
   * so last. They show over every copy of the message until that change is answered (§20.3).
   */
  const reacting = new Map<string, Map<string, { on: boolean; seq: number }>>();
  /** The requests for each message's reactions go one at a time, so the server applies them in the order they were made. */
  const reactQueues = new Map<string, Promise<unknown>>();
  let reactSeq = 0;
  const emit = (change: Change = {}) => {
    if (scope.active) opts.onChange(change);
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
  /** Highlight message `id` (or nothing) for HIGHLIGHT_MS: long enough to spot it, then it fades (app.css). */
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
    if (!ready() || !more || loading[side] || !win.items.length) return;
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
    const [before, after] = await Promise.all([api.page(older(roomId, target), signal), api.page(newer(roomId, target), signal)]);
    const win = merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [
      ...before,
      target,
      ...after,
    ]);
    return { win, target: target.id };
  }

  async function open() {
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
      phase = e instanceof ApiError && e.status === 404 ? "not-found" : "failed";
      return emit({ render: {} });
    }
    const loaded = await pageP.catch(() => null);
    await tokenP;
    if (!scope.active) return;
    const current = g === gen;
    // Never show a failed load as an empty room ("Beginning of #room"): say so and offer Retry.
    if (current && !loaded) {
      phase = "failed";
      return emit({ render: {} });
    }
    const change: Change = { render: {} };
    if (current && loaded) {
      win = loaded.win;
      setTarget(loaded.target);
      change.notice = msgId && !loaded.target ? "That message isn't in this room. Showing the latest messages instead." : "";
      // Otherwise the jump has positioned the list.
      change.scroll = targetId ? "target" : "bottom";
    }
    // Ready either way: a jump made during the load already owns the window, but still needs the view live.
    phase = "ready";
    emit(change);
    const pending = buffer;
    buffer = [];
    for (const [action, m] of pending) onMessage(action, m);
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
    if (!ready()) {
      buffer.push([action, m]);
      return;
    }
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
      await deliver(msg);
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
      saved = await api.send({
        id: msg.id,
        room: msg.room,
        text: msg.text,
        ...(files?.length ? { files } : {}),
        ...(replyTo ? { replyTo } : {}),
      });
    } catch (e) {
      if (!scope.active) return;
      // A retry of a send that already reached the server fails with a duplicate id: it was sent after all.
      const recovered = e instanceof ApiError && e.status === 400 ? await api.getMessage(msg.id, signal).catch(() => null) : null;
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
    if (!scope.active) return;
    // The window may have moved back in history meanwhile (a quote, a jump): then the message isn't in it, and
    // must not be put after older messages. Sent, it shows once the window is back at the live edge.
    if (saved) {
      unsent.delete(msg.id);
      if (find(msg.id)) win = merge(win, [saved]);
      revokeLocal(msg);
    } else if (failed && find(msg.id)?.status) win = merge(win, [failed]);
    else if (failed && unsent.has(msg.id)) unsent.set(msg.id, failed);
    emit({ render: {} });
  }

  async function retrySend(id: string) {
    const m = find(id);
    if (m?.status !== "failed") return;
    patchLocal(id, { status: "pending" });
    emit({ render: {} });
    await deliver({ ...m, status: "pending" });
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
      const saved = await request();
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
    const queue = (reactQueues.get(id) ?? Promise.resolve()).then(request);
    reactQueues.set(id, queue);
    reacting.set(id, mine.set(emoji, { on, seq }));
    emit({ render: { anchor: true } });
    const ok = await queue;
    if (reactQueues.get(id) === queue) reactQueues.delete(id);
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
    state: () => ({ win, phase, targetId, pill }),
    start() {
      scope.defer(() => {
        for (const m of [...win.items, ...unsent.values()]) revokeLocal(m);
      });
      // Keep a fresh file token for attachment URLs (§17.3); it only fetches when the cached one is old.
      const keepToken = setInterval(() => void api.fileToken().catch(() => {}), 30_000);
      scope.defer(() => clearInterval(keepToken));
      scope.defer(() => clearTimeout(targetTimer));
      // Room record changes (archive etc.) arrive through the store, kept live by sync.ts.
      scope.sub(api.subscribeMessages(roomId, onMessage));
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
    reactable: repliable,
    reactions: reactionsOf,
    react(id, emoji, on) {
      const m = find(id);
      return m && repliable(m) && me() ? react(id, emoji, on) : null;
    },
  };
}
