// App shell and boot (§7.1, TODO 3.5): restores the session, wires the router, header and logout.

import type { Api } from "./api.ts";
import { clear, h } from "./dom.ts";
import { createRouter, type Router, type View } from "./router.ts";
import { createStore, initialState, type AppState, type Store } from "./store.ts";
import { createLoginView } from "./views/login.ts";

export interface App {
  store: Store<AppState>;
  router: Router;
  stop(): void;
}

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);

/** Stand-in until the real views land (Phases 4–5). */
function placeholder(title: string): () => View {
  return () => ({
    mount(el) {
      el.replaceChildren(h("section", { class: "placeholder" }, h("h1", {}, title)));
    },
    unmount() {},
  });
}

export function startApp(deps: { api: Api; root: HTMLElement }): App {
  const { api, root } = deps;
  const store = createStore<AppState>({ ...initialState(), user: api.currentUser() });

  const header = h("header", { class: "app-bar" });
  const main = h("main", { class: "app-main" });
  clear(root);
  root.append(header, main);

  function logOut() {
    api.logOut();
    void api.unsubscribeAll().catch(() => {});
    store.set({ ...initialState() });
    router.refresh();
  }

  function renderHeader() {
    const user = store.get().user;
    header.hidden = !user;
    clear(header);
    if (!user) return;
    header.append(
      h("span", { class: "brand" }, "Chat"),
      h("span", { class: "who" }, user.name),
      h("button", { type: "button", class: "link", on: { click: logOut } }, "Log out"),
    );
  }

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
      { pattern: "#/", view: placeholder("Rooms") },
      { pattern: "#/r/:id", view: placeholder("Room") },
      { pattern: "#/r/:id/m/:msgId", view: placeholder("Room") },
    ],
  });

  const offStore = store.subscribe((s, prev) => {
    if (s.user !== prev.user) renderHeader();
  });
  renderHeader();
  router.start();

  const restored = store.get().user;
  if (restored) {
    api.refreshAuth().then(
      (user) => {
        if (store.get().user?.id === user.id) store.set({ user });
      },
      (err: { status?: number }) => {
        if (store.get().user?.id === restored.id && AUTH_REJECTED.has(err?.status ?? 0)) logOut();
      },
    );
  }

  return {
    store,
    router,
    stop() {
      offStore();
      router.stop();
      clear(root);
    },
  };
}
