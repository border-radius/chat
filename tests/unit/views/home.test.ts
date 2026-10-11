import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { createHomeView } from "../../../web/src/views/home.ts";

const user = { id: "u1", name: "Ada Lovelace", avatar: "" };

describe("home view (§7.1)", () => {
  let root: HTMLElement;
  let store: Store<AppState>;
  let view: View | undefined;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    store = createStore<AppState>({ ...initialState(), user });
  });
  afterEach(() => {
    view?.unmount();
    view = undefined;
    root.remove();
  });

  function mount() {
    view = createHomeView({ store });
    view.mount(root, {});
  }

  it("greets the user by first name and says what to do next", () => {
    mount();
    expect(root.querySelector("section.welcome h1")!.textContent).toBe("Welcome, Ada!");
    expect(root.querySelector("section.welcome p")!.textContent).toMatch(/pick a room/i);
  });

  it("follows a name change", () => {
    mount();
    store.set({ user: { ...user, name: "Grace Hopper" } });
    expect(root.querySelector("section.welcome h1")!.textContent).toBe("Welcome, Grace!");
  });

  it("stops listening once unmounted", () => {
    mount();
    view!.unmount();
    view = undefined;
    store.set({ user: { ...user, name: "Grace" } });
    expect(root.textContent).toBe("");
  });
});
