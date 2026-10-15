// App shell and boot (§7.1): restores the session, starts the room sync and unread counts and the tab's unread badge
// (§22.4), wires the router, header and logout (offered on the profile page, §22.2). Without a session the app is open
// to guests, who read the Open Air rooms and can log in or sign up from the header (§23.3).

import { createRoomActions } from "./actions.ts";
import { type Api, ApiError } from "./api.ts";
import { createCache, forgetGone } from "./cache.ts";
import type { Ctx } from "./context.ts";
import { clear, h } from "./dom.ts";
import { createDrafts } from "./drafts.ts";
import { startFavicon } from "./favicon.ts";
import type { User } from "./lib/types.ts";
import { createPrefetch } from "./prefetch.ts";
import { createRouter, here, type Router, type View } from "./router.ts";
import { startSite } from "./site.ts";
import { type AppState, createStore, initialState, type Store } from "./store.ts";
import { createSync } from "./sync.ts";
import { avatar } from "./ui/avatar.ts";
import { createUnread } from "./unread.ts";
import { createHomeView } from "./views/home.ts";
import { createLoginView } from "./views/login.ts";
import { createProfileView } from "./views/profile.ts";
import { createRoomView } from "./views/room.ts";
import { createRoomsView } from "./views/rooms.ts";

export interface App {
  store: Store<AppState>;
  router: Router;
  /** End the session and go home, as a guest (what the profile page's Log out does). */
  logOut(): void;
  stop(): void;
}

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);
/** Longest wait between session renewals, and the wait before another try after one failed for lack of network. */
const RENEW_MAX_MS = 24 * 60 * 60 * 1000;
const RENEW_RETRY_MS = 60 * 1000;
/**
 * A session can also be revoked before it expires: a password change signs out every other device. It is checked again
 * when the server refuses a change (at most this often), and when the tab comes back after this long (QA BUG-51).
 */
const CHECK_MIN_MS = 30 * 1000;
const CHECK_STALE_MS = 5 * 60 * 1000;

/** The pages for logging in and signing up: only for guests, and never where to go back to after logging in. */
const AUTH_PAGES = new Set(["/login", "/signup"]);

/** Starts the main view of the mounted layout over (a room that came back, §23.4). */
const panes = { reload: () => {} };

/**
 * Page layout (§7.1): the room list as a sidebar next to the main view. New params remount only the
 * main view, so switching rooms keeps the sidebar (and anything typed into it).
 */
function withSidebar(sidebar: () => View, main: () => View, layoutClass = ""): () => View {
  return () => {
    const side = sidebar();
    let pane = main();
    const content = h("div", { class: "pane" });
    let root: HTMLElement;
    let current: Record<string, string> = {};
    // A fresh view rather than a remount: late async work of the old one must not see itself as active.
    const fresh = () => {
      pane.unmount();
      pane = main();
      pane.mount(content, current);
    };
    return {
      mount(el, params) {
        root = el;
        current = params;
        panes.reload = fresh;
        const aside = h("aside", { class: "sidebar" });
        el.replaceChildren(h("div", { class: `layout ${layoutClass}`.trim() }, [aside, content]));
        side.mount(aside, {});
        pane.mount(content, params);
      },
      update(params) {
        current = params;
        fresh();
      },
      unmount() {
        if (panes.reload === fresh) panes.reload = () => {};
        pane.unmount();
        side.unmount();
        clear(root);
      },
    };
  };
}

export function startApp(deps: { api: Api; root: HTMLElement }): App {
  const { api, root } = deps;
  const store = createStore<AppState>({ ...initialState(), user: api.currentUser(), away: document.visibilityState === "hidden" });
  const sync = createSync({ api, store });
  const unread = createUnread({ api, store });
  const drafts = createDrafts(() => store.get().user?.id ?? "");
  const cache = createCache();
  const offGone = forgetGone(cache, store);
  const prefetch = createPrefetch({ api, store, cache });
  /** Start following the rooms (and, signed in, the unread counts and prefetching, §7.5) as whoever is logged in now, or as a guest. */
  let running = false;
  const startSession = () => {
    running = true;
    sync.start();
    if (!store.get().user) return;
    unread.start();
    prefetch.start();
  };
  /** The page a guest was on before going to log in or sign up: where logging in takes them back to (§23.3). */
  let lastPage = AUTH_PAGES.has(here()) ? "/" : here();
  const onNavigate = (path: string) => {
    if (!AUTH_PAGES.has(path)) lastPage = path;
  };

  const header = h("header", { class: "app-bar" });
  const main = h("main", { class: "app-main" });
  clear(root);
  root.append(header, main);

  /** Drop everything that belonged to the logged-in user. The session itself is left as it is. */
  function endSession() {
    if (!running) return; // logging out ends it before the auth change would (QA BUG-62)
    running = false;
    // Reads still waiting go out now, while the session is there. After another tab switched it to someone else,
    // this sends nothing: a reader only sends as the user it was opened for.
    unread.flush();
    unread.stop();
    prefetch.stop();
    sync.stop();
    void api.unsubscribeAll().catch(() => {});
    drafts.clear(store.get().user?.id ?? "");
    cache.clear();
    store.set({ ...initialState(), site: store.get().site });
  }

  /**
   * Someone else is logged in now (or nobody): everything that belonged to the previous one goes, the rooms are
   * followed again as the new one (or as a guest), and the views start over.
   */
  function switchTo(next: User | null, after = "/") {
    const fromAuthPage = AUTH_PAGES.has(here());
    endSession();
    if (next) store.set({ user: next });
    startSession();
    // Logged in from the login page: back to the room you were reading. Logged out: home (or `after`).
    if (next && fromAuthPage) history.replaceState(null, "", lastPage);
    if (!next) {
      history.replaceState(null, "", after);
      // After a logout, whoever logs in next starts from home, not from the page the previous user was on (their
      // profile, a room; QA BUG-59). An expired session is logged back into where it was.
      if (!AUTH_PAGES.has(after)) lastPage = "/";
    }
    router.remount();
  }

  /** `after`: where to go, as a guest. */
  function logOut(after = "/") {
    // End the session before clearing it, so the auth-change listener below sees nothing left to do.
    endSession();
    api.logOut();
    switchTo(null, after);
  }
  /** The session ran out or was revoked: the login page, and back to this page once logged in again. */
  const expire = () => logOut("/login");

  /**
   * Renew the session halfway through its lifetime, for as long as the tab stays open. A tab left open longer than a
   * session lasts (7 days by default) would otherwise look logged in while every request fails (QA BUG-45).
   */
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the session was last checked with the server (renewed, or found revoked). */
  let checkedAt = 0;
  function scheduleRenew(ms = Math.min(Math.max((api.sessionExpiry() - Date.now()) / 2, 0), RENEW_MAX_MS)) {
    clearTimeout(renewTimer);
    if (store.get().user) renewTimer = setTimeout(renew, ms);
  }
  function renew() {
    const user = store.get().user;
    if (!user) return;
    // Already over (e.g. the computer slept through it): it can't be renewed, so say so instead of failing quietly.
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
        else scheduleRenew(RENEW_RETRY_MS); // offline ≠ logged out: try again later
      },
    );
  }
  // Timers are late (or paused) while the computer sleeps or the tab is in the background: check on coming back.
  // Also check a session not checked for a while: revoked meanwhile, this tab would get nothing live and send nothing.
  const onVisible = () => {
    // Before the room view's own listener (registered later) reads what is on screen.
    store.set({ away: document.visibilityState === "hidden" });
    if (document.visibilityState !== "visible") return;
    if (store.get().user && Date.now() - checkedAt > CHECK_STALE_MS) renew();
    else scheduleRenew();
  };
  /** A refused change: was it the session? A revoked one logs out instead of failing every send ("Not sent"). */
  const onRejected = () => {
    if (store.get().user && Date.now() - checkedAt >= CHECK_MIN_MS) renew();
  };

  /**
   * The session is shared by every tab of this browser. When another tab logs out or logs in as someone else,
   * follow it: otherwise this tab would keep showing one user while its requests go out as another (or as nobody).
   */
  function onAuthChange() {
    const next = api.currentUser();
    const cur = store.get().user;
    if (next?.id === cur?.id) {
      // Same user: our own login/refresh, or a profile change (here or in another tab, BUG-33): follow name and avatar.
      if (next && cur && (next.name !== cur.name || (next.avatar ?? "") !== (cur.avatar ?? ""))) store.set({ user: next });
      return;
    }
    // Views mounted for the previous user (or the guest) hold its subscriptions and state: they start over.
    switchTo(next);
  }

  /** The site's logo (if any) and title (§24). */
  function brand() {
    const { title, logo } = store.get().site;
    return h("a", { href: "/", class: logo ? "brand has-logo" : "brand" }, [
      logo ? h("img", { src: logo, alt: "", class: "brand-logo" }) : null,
      h("span", { class: "brand-title" }, title),
    ]);
  }

  function renderHeader() {
    const user = store.get().user;
    clear(header);
    if (!user) {
      // A guest (§23.3): reading the Open Air rooms, with the way in.
      header.append(
        brand(),
        h("nav", { class: "guest-links", "aria-label": "Account" }, [
          h("a", { href: "/login", class: "guest-link" }, "Log in"),
          h("a", { href: "/signup", class: "guest-link primary" }, "Sign up"),
        ]),
      );
      return;
    }
    header.append(
      brand(),
      h("a", { href: "/me", class: "me-link", title: "Your profile" }, [
        avatar(user, 24, api.avatarUrl),
        h("span", { class: "who" }, user.name),
      ]),
    );
  }

  const ctx: Ctx = {
    api,
    store,
    sync,
    unread,
    actions: createRoomActions({ api, store }),
    navigate: (hash) => router.navigate(hash),
    reopen: () => panes.reload(),
    drafts,
    cache,
    logOut,
  };
  const rooms = () => createRoomsView(ctx);
  const roomPage = withSidebar(rooms, () => createRoomView(ctx));

  const authPage = (mode: "login" | "signup") => () =>
    createLoginView({
      api,
      store,
      mode,
      onLogin: (user) => {
        // Usually followed already: logging in changed the session (onAuthChange).
        if (store.get().user?.id !== user.id) switchTo(user);
        router.navigate(lastPage);
      },
    });
  const router = createRouter({
    onNavigate,
    root: main,
    isAuthed: () => store.get().user !== null,
    routes: [
      { pattern: "/login", public: true, guestOnly: true, view: authPage("login") },
      { pattern: "/signup", public: true, guestOnly: true, view: authPage("signup") },
      // Guests see the Open Air rooms (§23.3); a room they can't see says it doesn't exist.
      { pattern: "/", public: true, view: withSidebar(rooms, () => createHomeView(ctx), "home") },
      { pattern: "/r/:id", public: true, view: roomPage },
      { pattern: "/r/:id/m/:msgId", public: true, view: roomPage },
      { pattern: "/me", view: withSidebar(rooms, () => createProfileView(ctx)) },
    ],
  });

  const offStore = store.subscribe((s, prev) => {
    if (s.site !== prev.site) renderHeader();
    if (s.user === prev.user) return;
    renderHeader();
    if (s.user && !prev.user) scheduleRenew();
    if (!s.user) clearTimeout(renewTimer);
  });
  const offAuth = api.onAuthChange(onAuthChange);
  const offRejected = api.onRejected(onRejected);
  // A file dropped where nothing takes it must not make the browser open it and leave the app (QA BUG-27).
  // The room and the profile picture handle their own drops; this only cancels the browser's default.
  const swallowFileDrag = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", swallowFileDrag);
  window.addEventListener("drop", swallowFileDrag);
  document.addEventListener("visibilitychange", onVisible);
  const stopSite = startSite(api, store);
  const stopFavicon = startFavicon(store);
  renderHeader();
  startSession();
  router.start();

  // A restored session is checked (and renewed) right away.
  if (store.get().user) renew();

  return {
    store,
    router,
    logOut,
    stop() {
      offAuth();
      offRejected();
      window.removeEventListener("dragover", swallowFileDrag);
      window.removeEventListener("drop", swallowFileDrag);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(renewTimer);
      stopFavicon();
      stopSite();
      offStore();
      offGone();
      router.stop();
      unread.stop();
      prefetch.stop();
      sync.stop();
      clear(root);
    },
  };
}
