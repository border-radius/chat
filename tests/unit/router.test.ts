import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, matchRoute, type Router, type View } from "../../web/src/router.ts";
import { visit } from "../support/dom.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("matchRoute", () => {
  const routes = ["/", "/login", "/r/:id", "/r/:id/m/:msgId"].map((pattern) => ({ pattern }));
  const match = (path: string) => {
    const m = matchRoute(routes, path);
    return m && { pattern: m.route.pattern, params: m.params };
  };

  it("matches static and parameterized routes", () => {
    expect(match("/")).toEqual({ pattern: "/", params: {} });
    expect(match("/login")).toEqual({ pattern: "/login", params: {} });
    expect(match("/r/abc")).toEqual({ pattern: "/r/:id", params: { id: "abc" } });
    expect(match("/r/abc/m/xyz")).toEqual({ pattern: "/r/:id/m/:msgId", params: { id: "abc", msgId: "xyz" } });
  });

  it("decodes params", () => {
    expect(match("/r/a%20b")!.params.id).toBe("a b");
  });

  it("a malformed escape doesn't throw; it just doesn't match", () => {
    expect(match("/r/%E0%A4%A")).toBeNull();
    expect(match("/r/abc/m/%")).toBeNull();
  });

  it("treats an empty path as /", () => {
    expect(match("")!.pattern).toBe("/");
  });

  it("returns null for unknown paths and empty params", () => {
    expect(match("/nope")).toBeNull();
    expect(match("/r/")).toBeNull();
    expect(match("/r/a/b")).toBeNull();
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
    history.replaceState(null, "", "/");
    root = document.createElement("main");
    authed = true;
    log = [];
    router = createRouter({
      root,
      isAuthed: () => authed,
      routes: [
        { pattern: "/login", view: view("login"), public: true },
        { pattern: "/", view: view("rooms") },
        { pattern: "/r/:id", view: view("room") },
        { pattern: "/r/:id/m/:msgId", view: view("room-at") },
      ],
    });
  });

  afterEach(() => router.stop());

  it("mounts the current route on start", () => {
    history.replaceState(null, "", "/r/42");
    router.start();
    expect(log).toEqual([`mount room {"id":"42"}`]);
    expect(root.textContent).toBe("room");
  });

  it("navigate() unmounts the previous view before mounting the next", async () => {
    router.start();
    router.navigate("/r/1");
    await tick();
    expect(log).toEqual(["mount rooms {}", "unmount rooms", `mount room {"id":"1"}`]);
    expect(location.pathname).toBe("/r/1");
  });

  it("follows popstate (Back and Forward)", async () => {
    router.start();
    visit("/r/7/m/m1");
    await tick();
    expect(log.at(-1)).toBe(`mount room-at {"id":"7","msgId":"m1"}`);
  });

  it("navigating to the current route is a no-op", async () => {
    router.start();
    router.navigate("/");
    await tick();
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("remounts when only params change", async () => {
    history.replaceState(null, "", "/r/1");
    router.start();
    router.navigate("/r/2");
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
    history.replaceState(null, "", "/r/1");
    log = [];
    router = createRouter({
      root,
      isAuthed: () => true,
      routes: [
        { pattern: "/", view: view("rooms") },
        { pattern: "/r/:id", view: shared },
        { pattern: "/r/:id/m/:msgId", view: shared },
      ],
    });
    router.start();
    router.navigate("/r/2");
    await tick();
    router.navigate("/r/2/m/x");
    await tick();
    router.navigate("/");
    await tick();
    expect(log).toEqual([`mount {"id":"1"}`, `update {"id":"2"}`, `update {"id":"2","msgId":"x"}`, "unmount", "mount rooms {}"]);
  });

  it("unknown paths redirect to /", async () => {
    history.replaceState(null, "", "/does-not-exist");
    router.start();
    await tick();
    expect(location.pathname).toBe("/");
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("unauthenticated users are redirected to /login", async () => {
    authed = false;
    history.replaceState(null, "", "/r/9");
    router.start();
    await tick();
    expect(location.pathname).toBe("/login");
    expect(log).toEqual(["mount login {}"]);
  });

  it("authenticated users visiting /login go to /", async () => {
    history.replaceState(null, "", "/login");
    router.start();
    await tick();
    expect(location.pathname).toBe("/");
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("refresh() re-evaluates auth for the current route (e.g. after logout)", async () => {
    router.start();
    authed = false;
    router.refresh();
    await tick();
    expect(location.pathname).toBe("/login");
    expect(log).toEqual(["mount rooms {}", "unmount rooms", "mount login {}"]);
  });

  it("a malformed URL redirects to / instead of throwing", async () => {
    history.replaceState(null, "", "/r/%E0%A4%A");
    router.start();
    await tick();
    expect(location.pathname).toBe("/");
    expect(log).toEqual(["mount rooms {}"]);
  });

  it("remount() starts the current route over with a fresh view", async () => {
    router.start();
    router.remount();
    await tick();
    expect(log).toEqual(["mount rooms {}", "unmount rooms", "mount rooms {}"]);
  });

  it("stop() unmounts the current view and ignores further navigation", async () => {
    router.start();
    router.stop();
    visit("/r/5");
    await tick();
    expect(log).toEqual(["mount rooms {}", "unmount rooms"]);
  });

  describe("links", () => {
    /** Click a link (in the document, where the router listens); returns whether the router took the click. */
    const click = (attrs: Record<string, string>, init: MouseEventInit = {}) => {
      const a = document.createElement("a");
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      document.body.append(a);
      // Seen right after the router (registered later, on the same target): whether it took the click. Then the
      // browser's own action is cancelled: happy-dom would really load the link (and fail, there's no server).
      let taken = false;
      const after = (e: Event) => {
        taken = e.defaultPrevented;
        e.preventDefault();
      };
      document.addEventListener("click", after);
      // On the link itself: happy-dom follows a link as the click passes it, before document listeners, unless the
      // click starts there.
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      document.removeEventListener("click", after);
      a.remove();
      return taken;
    };

    it("a link to one of the pages shows it without loading the page again", () => {
      router.start();
      expect(click({ href: "/r/3" })).toBe(true);
      expect(location.pathname).toBe("/r/3");
      expect(log.at(-1)).toBe(`mount room {"id":"3"}`);
    });

    it("leaves other links to the browser: new tab or window, downloads, files", () => {
      router.start();
      const taken = [
        click({ href: "/r/3" }, { ctrlKey: true }),
        click({ href: "/r/3" }, { metaKey: true }),
        click({ href: "/r/3" }, { button: 1 }),
        click({ href: "/r/3", target: "_blank" }),
        click({ href: "/r/3", download: "" }),
        click({ href: "/api/files/messages/m1/a.png" }),
      ];
      expect(taken).toEqual([false, false, false, false, false, false]);
      expect(location.pathname).toBe("/");
      expect(log).toEqual(["mount rooms {}"]);
    });

    it("does nothing once stopped", () => {
      router.start();
      router.stop();
      expect(click({ href: "/r/3" })).toBe(false);
    });
  });

  it("a trailing slash is the same page", () => {
    history.replaceState(null, "", "/r/42/");
    router.start();
    expect(log).toEqual([`mount room {"id":"42"}`]);
  });

  it("passes over an image viewer entry (§17.7) it lands on: after a reload while one was open, or Forward after Back closed one", () => {
    const back = vi.spyOn(history, "back").mockImplementation(() => {});
    const land = (state: unknown) => {
      history.pushState(state, "", "/r/42");
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    history.replaceState({ viewer: "viewer-1" }, "", "/r/42");
    router.start();
    expect(back).toHaveBeenCalledTimes(1);
    expect(log).toEqual([`mount room {"id":"42"}`]);
    land(null);
    expect(back).toHaveBeenCalledTimes(1);
    land({ viewer: "viewer-1" });
    expect(back).toHaveBeenCalledTimes(2);
    expect(log).toEqual([`mount room {"id":"42"}`]);
    back.mockRestore();
  });

  describe("old-style #/ URLs (from before paths)", () => {
    it("are shown as their path on start", () => {
      history.replaceState(null, "", "/#/r/42");
      router.start();
      expect(location.pathname).toBe("/r/42");
      expect(location.hash).toBe("");
      expect(log).toEqual([`mount room {"id":"42"}`]);
    });

    it("are followed when one is opened in the tab", async () => {
      router.start();
      location.hash = "#/r/7";
      await tick();
      expect(location.pathname).toBe("/r/7");
      expect(location.hash).toBe("");
      expect(log.at(-1)).toBe(`mount room {"id":"7"}`);
    });
  });

  it("onNavigate hears where the user went, before redirects, and not the redirects themselves", async () => {
    router.stop();
    const went: string[] = [];
    router = createRouter({
      root,
      isAuthed: () => false,
      onNavigate: (path) => went.push(path),
      routes: [
        { pattern: "/login", view: view("login"), public: true },
        { pattern: "/", view: view("rooms"), public: true },
        { pattern: "/me", view: view("me") },
      ],
    });
    router.start();
    router.navigate("/me");
    visit("/");
    await tick();
    expect(went).toEqual(["/me", "/"]);
    expect(log).toEqual(["mount rooms {}", "unmount rooms", "mount login {}", "unmount login", "mount rooms {}"]);
  });
});
