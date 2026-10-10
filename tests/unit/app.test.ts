import PocketBase, { BaseAuthStore } from "pocketbase";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { type Api, ApiError, createApi } from "../../web/src/api.ts";
import { type App, startApp } from "../../web/src/app.ts";
import { newId } from "../../web/src/lib/id.ts";
import { instrument, newApi, signedUp } from "../support/api.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app boot (§7.1)", () => {
  let root: HTMLElement;
  let app: App | undefined;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    history.replaceState(null, "", "#/");
  });
  afterEach(() => {
    app?.stop();
    app = undefined;
    root.remove();
    vi.restoreAllMocks();
  });

  const logoutButton = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Log out");

  it("without a session it shows the login screen", async () => {
    app = startApp({ api: newApi(), root });
    await tick();
    expect(location.hash).toBe("#/login");
    expect(root.querySelector("form")).not.toBeNull();
    expect(logoutButton()).toBeUndefined();
  });

  it("with a stored session it goes straight to the route and refreshes auth in the background", async () => {
    const { api, user } = await signedUp("Ada");
    const ctl = instrument(api);
    history.replaceState(null, "", "#/r/abc");
    app = startApp({ api, root });
    expect(location.hash).toBe("#/r/abc");
    expect(app.store.get().user).toEqual(user);
    expect(ctl.calls("refreshAuth")).toBe(1);
    expect(root.textContent).toContain("Ada");
    expect(logoutButton()).toBeDefined();
  });

  it("the app bar shows your avatar and name, linking to #/me, and follows profile changes (§15.4)", async () => {
    const { api } = await signedUp("Ada Lovelace");
    app = startApp({ api, root });
    const link = root.querySelector<HTMLAnchorElement>("header.app-bar a.me-link")!;
    expect(link.getAttribute("href")).toBe("#/me");
    expect(link.querySelector(".avatar")!.textContent).toBe("AL");
    expect(link.querySelector(".who")!.textContent).toBe("Ada Lovelace");

    location.hash = "#/me";
    await vi.waitFor(() => expect(root.querySelector("section.profile")).not.toBeNull());
    expect(root.querySelector("aside.sidebar")).not.toBeNull();
    app.store.set({ user: await api.rename("Grace") });
    expect(root.querySelector("header.app-bar .who")!.textContent).toBe("Grace");
    await api.unsubscribeAll();
  });

  it("BUG-27: a file dragged over or dropped anywhere doesn't make the browser open it; other drags are left alone", async () => {
    const { api } = await signedUp("Ada");
    app = startApp({ api, root });
    const drag = (type: "dragover" | "drop", types: string[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { types, files: [] } });
      root.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(drag("dragover", ["Files"])).toBe(true);
    expect(drag("drop", ["Files"])).toBe(true);
    expect(drag("dragover", ["text/plain"])).toBe(false);
    app.stop();
    app = undefined;
    expect(drag("drop", ["Files"])).toBe(false);
    await api.unsubscribeAll();
  });

  it("#/r/:id shows the room with the room list as a sidebar; navigating between rooms switches the room", async () => {
    const { api } = await signedUp("Ada");
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    history.replaceState(null, "", `#/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    const sidebar = root.querySelector("aside.sidebar")!;
    expect(sidebar.querySelector('nav[aria-label="Rooms"]')).not.toBeNull();
    await vi.waitFor(() => expect(sidebar.querySelector(`a[href="#/r/${r1.id}"]`)?.getAttribute("aria-current")).toBe("page"));
    expect(root.querySelector("form.composer")).not.toBeNull();

    location.hash = `#/r/${r2.id}`;
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(app.store.get().activeRoomId).toBe(r2.id);
    await api.unsubscribeAll();
  });

  it("switching rooms keeps the sidebar mounted: no refetch, and a half-typed room name survives", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    history.replaceState(null, "", `#/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    const sidebar = root.querySelector("aside.sidebar")!;
    const input = sidebar.querySelector<HTMLInputElement>('form.new-room input[name="name"]')!;
    input.value = "half-typ";
    const fetches = ctl.calls("listRooms");

    location.hash = `#/r/${r2.id}`;
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(root.querySelector("aside.sidebar")).toBe(sidebar);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("half-typ");
    expect(ctl.calls("listRooms")).toBe(fetches);
    expect(ctl.calls("subscribeRooms")).toBe(1); // one app-wide subscription, not one per view
    await vi.waitFor(() => expect(sidebar.querySelector(`a[href="#/r/${r2.id}"]`)?.getAttribute("aria-current")).toBe("page"));
  });

  it("a network failure during the background refresh keeps the session (offline ≠ logged out)", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    ctl.failNext("refreshAuth", new ApiError("Failed to fetch", 0));
    app = startApp({ api, root });
    await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
    await tick();
    expect(app.store.get().user?.name).toBe("Ada");
    expect(location.hash).toBe("#/");
  });

  it("a session rejected by the server logs out to the login screen", async () => {
    const { api } = await signedUp("Ada");
    instrument(api).failNext("refreshAuth", new ApiError("The request requires valid record authorization token.", 401));
    app = startApp({ api, root });
    await vi.waitFor(() => expect(location.hash).toBe("#/login"));
    expect(app.store.get().user).toBeNull();
    expect(api.currentUser()).toBeNull();
  });

  it("logging in through the form goes to the room list", async () => {
    const ada = await signedUp("Ada");
    app = startApp({ api: newApi(), root });
    await tick();
    root.querySelector<HTMLInputElement>('input[name="email"]')!.value = ada.email;
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = ada.password;
    root.querySelector("form")!.requestSubmit();
    await vi.waitFor(() => expect(location.hash).toBe("#/"));
    expect(app.store.get().user).toEqual(ada.user);
    expect(logoutButton()).toBeDefined();
    await vi.waitFor(() => expect(root.querySelector('nav[aria-label="Rooms"]')).not.toBeNull()); // mounted on hashchange
    expect(root.querySelector('form.new-room input[name="name"]')).not.toBeNull();
  });

  it("log out clears auth, drops realtime subscriptions and returns to login", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    app = startApp({ api, root });
    logoutButton()!.click();
    await tick();
    expect(api.currentUser()).toBeNull();
    expect(ctl.calls("unsubscribeAll")).toBe(1);
    expect(app.store.get().user).toBeNull();
    expect(location.hash).toBe("#/login");
    expect(logoutButton()).toBeUndefined();
    expect(app.store.get().rooms.size).toBe(0);
  });

  it("after logout, going back to a room shows the login screen, not room content", async () => {
    const { api } = await signedUp("Ada");
    history.replaceState(null, "", "#/r/abc");
    app = startApp({ api, root });
    logoutButton()!.click();
    await tick();
    location.hash = "#/r/abc";
    await tick();
    expect(location.hash).toBe("#/login");
  });

  describe("another tab changes the shared session (BUG-02, BUG-03)", () => {
    const opened: Api[] = [];
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((a) => a.unsubscribeAll().catch(() => {})));
    });

    /** A client whose auth store the test can change directly, as another tab would through localStorage. */
    async function sharedSession(email: string, password: string) {
      const pb = new PocketBase(inject("pbUrl"), new BaseAuthStore());
      const api = createApi(pb);
      opened.push(api);
      await api.logIn(email, password);
      return { pb, api };
    }

    it("BUG-33: a profile change in another tab (same user) updates this tab's app bar, without a reset", async () => {
      const ada = await signedUp("Ada");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      const ctl = instrument(api);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      const listsBefore = ctl.calls("listRooms");
      pb.authStore.save(pb.authStore.token, { ...pb.authStore.record!, name: "Ada King", avatar: "new_abcdefghij.png" });
      await tick();
      expect(root.querySelector(".who")?.textContent).toBe("Ada King");
      expect(root.querySelector("header.app-bar img.avatar")?.getAttribute("src")).toContain("new_abcdefghij.png");
      expect(app.store.get().user).toMatchObject({ id: ada.user.id, name: "Ada King" });
      expect(ctl.calls("listRooms")).toBe(listsBefore); // same user: the session wasn't restarted
    });

    it("a logout in another tab logs this tab out too", async () => {
      const ada = await signedUp("Ada");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      app = startApp({ api, root });
      expect(logoutButton()).toBeDefined();
      pb.authStore.clear();
      await tick();
      expect(app.store.get().user).toBeNull();
      expect(location.hash).toBe("#/login");
      expect(logoutButton()).toBeUndefined();
    });

    it("a login as someone else in another tab switches this tab to that user", async () => {
      const ada = await signedUp("Ada");
      const bob = await signedUp("Bob");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      const room = await api.createRoom(`r-${newId()}`);
      history.replaceState(null, "", `#/r/${room.id}`);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(root.querySelector(".who")?.textContent).toBe("Ada"));
      const other = new PocketBase(inject("pbUrl"), new BaseAuthStore());
      await other.collection("users").authWithPassword(bob.email, bob.password);
      pb.authStore.save(other.authStore.token, other.authStore.record);
      await vi.waitFor(() => expect(root.querySelector(".who")?.textContent).toBe("Bob"));
      expect(app.store.get().user?.id).toBe(bob.user.id);
      // The room view was started over for Bob: its own messages are his.
      await vi.waitFor(() => expect(root.querySelector("form.composer")).not.toBeNull());
      const sent = await api.send({ id: newId(), room: room.id, text: "hi" });
      expect(sent.author).toBe(bob.user.id);
    });

    it("our own login, refresh and logout don't trigger a second reset", async () => {
      const ada = await signedUp("Ada");
      const { api } = await sharedSession(ada.email, ada.password);
      const ctl = instrument(api);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      await tick();
      expect(ctl.calls("unsubscribeAll")).toBe(0);
      logoutButton()!.click();
      await tick();
      expect(ctl.calls("unsubscribeAll")).toBe(1);
    });
  });
});
