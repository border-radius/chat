import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouter, matchRoute, type Router, type View } from "../../web/src/router.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("matchRoute", () => {
  const routes = ["#/", "#/login", "#/r/:id", "#/r/:id/m/:msgId"].map((pattern) => ({ pattern }));
  const match = (hash: string) => {
    const m = matchRoute(routes, hash);
    return m && { pattern: m.route.pattern, params: m.params };
  };

  it("matches static and parameterized routes", () => {
    expect(match("#/")).toEqual({ pattern: "#/", params: {} });
    expect(match("#/login")).toEqual({ pattern: "#/login", params: {} });
    expect(match("#/r/abc")).toEqual({ pattern: "#/r/:id", params: { id: "abc" } });
    expect(match("#/r/abc/m/xyz")).toEqual({ pattern: "#/r/:id/m/:msgId", params: { id: "abc", msgId: "xyz" } });
  });

  it("decodes params", () => {
    expect(match("#/r/a%20b")!.params.id).toBe("a b");
  });

  it("treats an empty hash as #/", () => {
    expect(match("")!.pattern).toBe("#/");
    expect(match("#")!.pattern).toBe("#/");
  });

  it("returns null for unknown paths and empty params", () => {
    expect(match("#/nope")).toBeNull();
    expect(match("#/r/")).toBeNull();
    expect(match("#/r/a/b")).toBeNull();
  });
});

describe("createRouter", () => {
  let root: HTMLElement;
  let authed: boolean;
  let log: string[];
  let router: Router;

  const view = (name: string) => (): View => ({
    mount(el, params) {
      log.push(`mount ${name} ${JSON.stringify(params)}`);
      el.textContent = name;
    },
    unmount() {
      log.push(`unmount ${name}`);
    },
  });

  beforeEach(() => {
    history.replaceState(null, "", "#/");
    root = document.createElement("main");
    authed = true;
    log = [];
    router = createRouter({
      root,
      isAuthed: () => authed,
      routes: [
        { pattern: "#/login", view: view("login"), public: true },
        { pattern: "#/", view: view("rooms") },
        { pattern: "#/r/:id", view: view("room") },
        { pattern: "#/r/:id/m/:msgId", view: view("room-at") },
      ],
    });
  });

  afterEach(() => router.stop());

  it("mounts the current route on start", () => {
    history.replaceState(null, "", "#/r/42");
    router.start();
    expect(log).toEqual([`mount room {"id":"42"}`]);
    expect(root.textContent).toBe("room");
  });

  it("navigate() unmounts the previous view before mounting the next", async () => {
    router.start();
    router.navigate("#/r/1");
    await tick();
    expect(log).toEqual(["mount rooms {}", "unmount rooms", `mount room {"id":"1"}`]);
    expect(location.hash).toBe("#/r/1");
  });

  it("follows hashchange (back/forward, links)", async () => {
    router.start();
    location.hash = "#/r/7/m/m1";
    await tick();
    expect(log.at(-1)).toBe(`mount room-at {"id":"7","msgId":"m1"}`);
  });

  it("navigating to the current route is a no-op", async () => {
    router.start();
    router.navigate("#/");
    await tick();
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("remounts when only params change", async () => {
    history.replaceState(null, "", "#/r/1");
    router.start();
    router.navigate("#/r/2");
    await tick();
    expect(log).toEqual([`mount room {"id":"1"}`, "unmount room", `mount room {"id":"2"}`]);
  });

  it("a view with update() takes new params in place when the next route uses the same view factory", async () => {
    router.stop();
    const shared = (): View => ({
      mount: (_el, params) => void log.push(`mount ${JSON.stringify(params)}`),
      update: (params) => void log.push(`update ${JSON.stringify(params)}`),
      unmount: () => void log.push("unmount"),
    });
    history.replaceState(null, "", "#/r/1");
    log = [];
    router = createRouter({
      root,
      isAuthed: () => true,
      routes: [
        { pattern: "#/", view: view("rooms") },
        { pattern: "#/r/:id", view: shared },
        { pattern: "#/r/:id/m/:msgId", view: shared },
      ],
    });
    router.start();
    router.navigate("#/r/2");
    await tick();
    router.navigate("#/r/2/m/x");
    await tick();
    router.navigate("#/");
    await tick();
    expect(log).toEqual([`mount {"id":"1"}`, `update {"id":"2"}`, `update {"id":"2","msgId":"x"}`, "unmount", "mount rooms {}"]);
  });

  it("unknown hashes redirect to #/", async () => {
    history.replaceState(null, "", "#/does-not-exist");
    router.start();
    await tick();
    expect(location.hash).toBe("#/");
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("unauthenticated users are redirected to #/login", async () => {
    authed = false;
    history.replaceState(null, "", "#/r/9");
    router.start();
    await tick();
    expect(location.hash).toBe("#/login");
    expect(log).toEqual(["mount login {}"]);
  });

  it("authenticated users visiting #/login go to #/", async () => {
    history.replaceState(null, "", "#/login");
    router.start();
    await tick();
    expect(location.hash).toBe("#/");
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("refresh() re-evaluates auth for the current route (e.g. after logout)", async () => {
    router.start();
    authed = false;
    router.refresh();
    await tick();
    expect(location.hash).toBe("#/login");
    expect(log).toEqual(["mount rooms {}", "unmount rooms", "mount login {}"]);
  });

  it("stop() unmounts the current view and ignores further hash changes", async () => {
    router.start();
    router.stop();
    location.hash = "#/r/5";
    await tick();
    expect(log).toEqual(["mount rooms {}", "unmount rooms"]);
  });
});
