import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { startApp, type App } from "../../web/src/app.ts";
import { newId } from "../../web/src/lib/id.ts";
import { instrument, newApi, signedUp } from "../support/api.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app boot (§7.1, TODO 3.5)", () => {
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
});
