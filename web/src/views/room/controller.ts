// Room controller (§7.5, §7.6): one room's message window and everything that changes it. That covers loading,
// realtime, reconnects, sending, edits and deletes. No DOM: every change is reported to `onChange` with a hint
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
  remove,
  trim,
} from "../../lib/messages.ts";
import { parsePb, toPb } from "../../lib/time.ts";
import type { LocalFile, Message, Room } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import { type AppState, type Store, upsertRoom } from "../../store.ts";

/** "loading" until the first page is in; "failed" offers Retry; "not-found": no such room (or not yours). */
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
  /** The user is at the bottom now: hide a "new messages below" pill. */
  dismissPill(): void;
  find(id: string): Message | undefined;
  /** Can I edit or delete this message right now? */
  editable(m: Message): boolean;
  /** My newest editable message (Up arrow in an empty composer). */
  lastEditable(): Message | undefined;
  /** Send optimistically. False when sending isn't possible (no user, archived room). */
  send(text: string, files?: LocalFile[]): boolean;
  retrySend(id: string): Promise<void>;
  /** Drop a failed message (no request). */
  discard(id: string): void;
  /** Save validated text. null: nothing to save (unchanged, or no longer editable). Resolves false if the save failed. */
  edit(id: string, text: string): Promise<boolean> | null;
  /** Soft delete. null: not in the window. Resolves false if the delete failed. */
  remove(id: string): Promise<boolean> | null;
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
  let pill: Pill = null;
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  /** Realtime events that arrive before the first page; replayed once it is in. */
  let buffer: [Action, Message][] = [];
  const loading = { top: false, bottom: false };

  const ready = () => phase === "ready";
  const room = (): Room | undefined => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  const find = (id: string) => win.items.find((m) => m.id === id);
  const editable = (m: Message) => {
    const r = room();
    return !!r && !r.archived && m.author === me()?.id && !m.deleted && !m.status;
  };
  const emit = (change: Change = {}) => {
    if (scope.active) opts.onChange(change);
  };
  /** Local optimistic change that must win regardless of `updated` (edit/delete/revert). */
  const patchLocal = (id: string, patch: Partial<Message>) => {
    win = { ...win, items: win.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
  };
  /** Release a local message's preview URLs (sent, discarded, or the room is going away). */
  const revokeLocal = (m: Message | undefined) => {
    for (const f of m?.localFiles ?? []) if (f.url) URL.revokeObjectURL(f.url);
  };

  // ---------------------------------------------------------------- loading

  /** Apply a page fetched under generation `g`, unless a jump (or the end of the scope) has made it stale. */
  function applyLoaded(kind: PageKind, page: Message[], g: number): boolean {
    if (g !== gen || !scope.active) return false;
    win = applyPage(win, page, kind).win;
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
    targetId = null;
    emit({ render: {}, notice: "", scroll: kind === "latest" ? "bottom" : "top" });
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
      targetId = loaded.target;
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
      win = applyPage(win, page, last ? "newer" : "latest").win;
      if (page.length < PAGE_SIZE) break;
    }
    win = { ...win, hasNewer: false };
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

  function send(text: string, files: LocalFile[] = []): boolean {
    const user = me();
    const r = room();
    if (!user || !r || r.archived) return false;
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
        expand: { author: { id: user.id, name: user.name, avatar: user.avatar ?? "" } },
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
    try {
      const files = msg.localFiles?.map((f) => f.file);
      const saved = await api.send({ id: msg.id, room: msg.room, text: msg.text, ...(files?.length ? { files } : {}) });
      if (!scope.active) return;
      win = merge(win, [saved]);
      emit({ render: {} });
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

  // ---------------------------------------------------------------- lifecycle

  return {
    state: () => ({ win, phase, targetId, pill }),
    start() {
      scope.defer(() => {
        for (const m of win.items) revokeLocal(m);
      });
      // Keep a fresh file token for attachment URLs (§17.3); it only fetches when the cached one is old.
      const keepToken = setInterval(() => void api.fileToken().catch(() => {}), 30_000);
      scope.defer(() => clearInterval(keepToken));
      // Room record changes (archive etc.) arrive through the store, kept live by sync.ts.
      scope.sub(api.subscribeMessages(roomId, onMessage));
      scope.defer(api.onConnect((reconnect) => reconnect && onReconnect()));
      void open();
    },
    retry,
    loadEdge,
    jump,
    dismissPill() {
      if (pill !== "below") return;
      pill = null;
      emit();
    },
    find,
    editable,
    lastEditable() {
      const mine = lastOwnEditable(win, me()?.id ?? "");
      return mine && editable(mine) ? mine : undefined;
    },
    send,
    retrySend,
    discard,
    edit,
    remove: removeMessage,
  };
}
