// App shell and boot (§7.1): restores the session, starts the room sync and unread counts and the tab's unread badge
// (§22.4), wires the router, header and logout (offered on the profile page, §22.2).

import { createRoomActions } from "./actions.ts";
import { type Api, ApiError } from "./api.ts";
import type { Ctx } from "./context.ts";
import { clear, h } from "./dom.ts";
import { createDrafts } from "./drafts.ts";
import { startFavicon } from "./favicon.ts";
import { createRouter, type Router, type View } from "./router.ts";
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
  /** End the session and go to the login screen (what the profile page's Log out does). */
  logOut(): void;
  stop(): void;
}

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);
/** Longest wait between session renewals, and the wait before another try after one failed for lack of network. */
const RENEW_MAX_MS = 24 * 60 * 60 * 1000;
const RENEW_RETRY_MS = 60 * 1000;

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
    return {
      mount(el, params) {
        root = el;
        const aside = h("aside", { class: "sidebar" });
        el.replaceChildren(h("div", { class: `layout ${layoutClass}`.trim() }, [aside, content]));
        side.mount(aside, {});
        pane.mount(content, params);
      },
      update(params) {
        // A fresh view rather than a remount: late async work of the old one must not see itself as active.
        pane.unmount();
        pane = main();
        pane.mount(content, params);
      },
      unmount() {
        pane.unmount();
        side.unmount();
        clear(root);
      },
    };
  };
}

export function startApp(deps: { api: Api; root: HTMLElement }): App {
  const { api, root } = deps;
  const store = createStore<AppState>({ ...initialState(), user: api.currentUser() });
  const sync = createSync({ api, store });
  const unread = createUnread({ api, store });
  const drafts = createDrafts(() => store.get().user?.id ?? "");
  const startSession = () => {
    sync.start();
    unread.start();
  };

  const header = h("header", { class: "app-bar" });
  const main = h("main", { class: "app-main" });
  clear(root);
  root.append(header, main);

  /** Drop everything that belonged to the logged-in user. The session itself is left as it is. */
  function endSession() {
    // Reads still waiting go out now, while the session is there. After another tab switched it to someone else,
    // this sends nothing: a reader only sends as the user it was opened for.
    unread.flush();
    unread.stop();
    sync.stop();
    void api.unsubscribeAll().catch(() => {});
    drafts.clear(store.get().user?.id ?? "");
    store.set({ ...initialState() });
  }

  function logOut() {
    // End the session before clearing it, so the auth-change listener below sees nothing left to do.
    endSession();
    api.logOut();
    router.refresh();
  }

  /**
   * Renew the session halfway through its lifetime, for as long as the tab stays open. A tab left open longer than a
   * session lasts (7 days by default) would otherwise look logged in while every request fails (QA BUG-45).
   */
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleRenew(ms = Math.min(Math.max((api.sessionExpiry() - Date.now()) / 2, 0), RENEW_MAX_MS)) {
    clearTimeout(renewTimer);
    if (store.get().user) renewTimer = setTimeout(renew, ms);
  }
  function renew() {
    const user = store.get().user;
    if (!user) return;
    // Already over (e.g. the computer slept through it): it can't be renewed, so say so instead of failing quietly.
    if (api.sessionExpiry() <= Date.now()) return logOut();
    api.refreshAuth().then(
      (fresh) => {
        if (store.get().user?.id !== fresh.id) return;
        store.set({ user: fresh });
        scheduleRenew();
      },
      (err: unknown) => {
        if (store.get().user?.id !== user.id) return;
        if (err instanceof ApiError && AUTH_REJECTED.has(err.status)) logOut();
        else scheduleRenew(RENEW_RETRY_MS); // offline ≠ logged out: try again later
      },
    );
  }
  // Timers are late (or paused) while the computer sleeps or the tab is in the background: check on coming back.
  const onVisible = () => document.visibilityState === "visible" && scheduleRenew();

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
    if (cur) endSession();
    if (next) store.set({ user: next });
    // Views mounted for the previous user hold its subscriptions and state: start them over.
    if (cur) router.remount();
    else router.refresh();
  }

  function renderHeader() {
    const user = store.get().user;
    header.hidden = !user;
    clear(header);
    if (!user) return;
    header.append(
      h("span", { class: "brand" }, "Chat"),
      h("a", { href: "#/me", class: "me-link", title: "Your profile" }, [
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
    drafts,
    logOut,
  };
  const rooms = () => createRoomsView(ctx);
  const roomPage = withSidebar(rooms, () => createRoomView(ctx));

  const router = createRouter({
    root: main,
    isAuthed: () => store.get().user !== null,
    routes: [
      {
        pattern: "#/login",
        public: true,
        view: () =>
          createLoginView({
            api,
            onLogin: (user) => {
              store.set({ user });
              router.navigate("#/");
            },
          }),
      },
      { pattern: "#/", view: withSidebar(rooms, () => createHomeView(ctx), "home") },
      { pattern: "#/r/:id", view: roomPage },
      { pattern: "#/r/:id/m/:msgId", view: roomPage },
      { pattern: "#/me", view: withSidebar(rooms, () => createProfileView(ctx)) },
    ],
  });

  const offStore = store.subscribe((s, prev) => {
    if (s.user === prev.user) return;
    renderHeader();
    if (s.user && !prev.user) {
      startSession();
      scheduleRenew();
    }
    if (!s.user) clearTimeout(renewTimer);
  });
  const offAuth = api.onAuthChange(onAuthChange);
  // A file dropped where nothing takes it must not make the browser open it and leave the app (QA BUG-27).
  // The room and the profile picture handle their own drops; this only cancels the browser's default.
  const swallowFileDrag = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", swallowFileDrag);
  window.addEventListener("drop", swallowFileDrag);
  document.addEventListener("visibilitychange", onVisible);
  const stopFavicon = startFavicon(store);
  renderHeader();
  if (store.get().user) startSession();
  router.start();

  // A restored session is checked (and renewed) right away.
  if (store.get().user) renew();

  return {
    store,
    router,
    logOut,
    stop() {
      offAuth();
      window.removeEventListener("dragover", swallowFileDrag);
      window.removeEventListener("drop", swallowFileDrag);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(renewTimer);
      stopFavicon();
      offStore();
      router.stop();
      unread.stop();
      sync.stop();
      clear(root);
    },
  };
}
