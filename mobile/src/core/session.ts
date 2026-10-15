// One server's session (the web's app.ts, §7.1, without the DOM): the API, the app state and the services that keep it
// live (rooms, unread counts, prefetching), drafts, the room cache, and the session's own life: renewed halfway
// through, checked when the server refuses a change or the app comes back after a while, and ended (to the login
// screen) when it was revoked or ran out. Logging in or out starts the services over as the new user (or a guest).

import { AppState as RNAppState } from "react-native";
import {
  type Api,
  ApiError,
  type AppState,
  type Cache,
  createApi,
  createAuthStore,
  createDrafts,
  createPrefetch,
  createRoomActions,
  createStore,
  createSync,
  createUnread,
  type Drafts,
  initialState,
  type RoomActions,
  type Store,
  type Sync,
  startSite,
  type Unread,
  type User,
} from "../shared";
import { createCache } from "./cache";
import { createNativeClient } from "./client";
import { createStorage } from "./kv";
import { persistAuth } from "./servers";
import { reviveAll } from "./sse";

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);
const RENEW_MAX_MS = 24 * 60 * 60 * 1000;
const RENEW_RETRY_MS = 60 * 1000;
const CHECK_MIN_MS = 30 * 1000;
const CHECK_STALE_MS = 5 * 60 * 1000;
/** Back in the app after this long in the background: the realtime connection is started over (Android drops it). */
const REVIVE_AFTER_MS = 20 * 1000;

export interface Session {
  readonly server: string;
  readonly api: Api;
  readonly store: Store<AppState>;
  readonly sync: Sync;
  readonly unread: Unread;
  readonly actions: RoomActions;
  readonly drafts: Drafts;
  readonly cache: Cache;
  /** End the session; the app goes on as a guest of this server. */
  logOut(): void;
  /** The session ran out or was revoked (not a logout): e.g. to show the login screen. Returns an unsubscribe function. */
  onExpired(fn: () => void): () => void;
  /** Stop everything (switching to another server). */
  stop(): void;
}

export async function openSession(server: string): Promise<Session> {
  const authStore = createAuthStore();
  const stopPersisting = await persistAuth(server, authStore);
  const api = createApi(createNativeClient(server, authStore));
  const kv = createStorage(`srv:${server}`);
  const store = createStore<AppState>({ ...initialState(), user: api.currentUser(), away: RNAppState.currentState !== "active" });
  const sync = createSync({ api, store });
  const unread = createUnread({ api, store });
  const drafts = createDrafts(() => store.get().user?.id ?? "", kv);
  const cache = createCache(server);
  const prefetch = createPrefetch({ api, store, cache });
  const expired = new Set<() => void>();

  let running = false;
  const startSession = () => {
    running = true;
    sync.start();
    if (!store.get().user) return;
    unread.start();
    prefetch.start();
  };

  function endSession() {
    if (!running) return;
    running = false;
    unread.flush();
    unread.stop();
    prefetch.stop();
    sync.stop();
    void api.unsubscribeAll().catch(() => {});
    drafts.clear(store.get().user?.id ?? "");
    cache.clear();
    store.set({ ...initialState(), site: store.get().site, away: store.get().away });
  }

  function switchTo(next: User | null) {
    endSession();
    if (next) store.set({ user: next });
    startSession();
  }

  function logOut() {
    endSession();
    api.logOut();
    switchTo(null);
  }

  const expire = () => {
    logOut();
    for (const fn of [...expired]) fn();
  };

  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let checkedAt = 0;
  function scheduleRenew(ms = Math.min(Math.max((api.sessionExpiry() - Date.now()) / 2, 0), RENEW_MAX_MS)) {
    clearTimeout(renewTimer);
    if (store.get().user) renewTimer = setTimeout(renew, ms);
  }
  function renew() {
    const user = store.get().user;
    if (!user) return;
    if (api.sessionExpiry() <= Date.now()) return expire();
    checkedAt = Date.now();
    api.refreshAuth().then(
      (fresh) => {
        if (store.get().user?.id !== fresh.id) return;
        store.set({ user: fresh });
        scheduleRenew();
      },
      (err: unknown) => {
        if (store.get().user?.id !== user.id) return;
        if (err instanceof ApiError && AUTH_REJECTED.has(err.status)) expire();
        else scheduleRenew(RENEW_RETRY_MS);
      },
    );
  }

  /** Background and foreground, like a browser tab's visibility (§22.4): away, nobody reads the open room. */
  let backgroundAt = 0;
  const appState = RNAppState.addEventListener("change", (state) => {
    const away = state !== "active";
    if (away === store.get().away) return;
    store.set({ away });
    if (away) {
      backgroundAt = Date.now();
      unread.flush();
      return;
    }
    if (backgroundAt && Date.now() - backgroundAt > REVIVE_AFTER_MS) reviveAll();
    if (store.get().user && Date.now() - checkedAt > CHECK_STALE_MS) renew();
    else scheduleRenew();
  });

  const offRejected = api.onRejected(() => {
    if (store.get().user && Date.now() - checkedAt >= CHECK_MIN_MS) renew();
  });
  const offAuth = api.onAuthChange(() => {
    const next = api.currentUser();
    const cur = store.get().user;
    if (next?.id === cur?.id) {
      if (next && cur && (next.name !== cur.name || (next.avatar ?? "") !== (cur.avatar ?? ""))) store.set({ user: next });
      return;
    }
    switchTo(next);
  });
  const offStore = store.subscribe((s, prev) => {
    if (s.user === prev.user) return;
    if (s.user && !prev.user) scheduleRenew();
    if (!s.user) clearTimeout(renewTimer);
  });
  const stopSite = startSite(api, store, kv);

  startSession();
  if (store.get().user) renew();

  return {
    server,
    api,
    store,
    sync,
    unread,
    actions: createRoomActions({ api, store }),
    drafts,
    cache,
    logOut,
    onExpired(fn) {
      expired.add(fn);
      return () => void expired.delete(fn);
    },
    stop() {
      unread.flush();
      appState.remove();
      offRejected();
      offAuth();
      offStore();
      stopSite();
      clearTimeout(renewTimer);
      unread.stop();
      prefetch.stop();
      sync.stop();
      void api.unsubscribeAll().catch(() => {});
      stopPersisting();
    },
  };
}
