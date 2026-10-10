// App shell and boot (§7.1, TODO 3.5): restores the session, wires the router, header and logout.

import type { Api } from "./api.ts";
import { clear, h } from "./dom.ts";
import { createRouter, type Router, type View } from "./router.ts";
import { createStore, initialState, type AppState, type Store } from "./store.ts";
import { createLoginView } from "./views/login.ts";
import { createRoomView } from "./views/room.ts";
import { createRoomsView } from "./views/rooms.ts";

export interface App {
  store: Store<AppState>;
  router: Router;
  stop(): void;
}

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);

/** Room page layout (§7.1): the room list as a sidebar next to the main view. */
function withSidebar(sidebar: () => View, main: () => View): () => View {
  return () => {
    const side = sidebar();
    const pane = main();
    let root: HTMLElement;
    return {
      mount(el, params) {
        root = el;
        const aside = h("aside", { class: "sidebar" });
        const content = h("div", { class: "pane" });
        el.replaceChildren(h("div", { class: "layout" }, [aside, content]));
        side.mount(aside, {});
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

  const navigate = (hash: string) => router.navigate(hash);
  const rooms = () => createRoomsView({ api, store, navigate });
  const roomPage = withSidebar(rooms, () => createRoomView({ api, store, navigate }));

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
      { pattern: "#/", view: rooms },
      { pattern: "#/r/:id", view: roomPage },
      { pattern: "#/r/:id/m/:msgId", view: roomPage },
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
