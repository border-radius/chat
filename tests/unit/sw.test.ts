import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// sw.ts's notification click (§34), with the worker's scope played by the test window: its listeners are caught as
// it registers them, its `clients` are fakes.

interface Tab {
  url: string;
  focused: boolean;
  visibilityState: DocumentVisibilityState;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}
const tab = (focused: boolean, visibilityState: DocumentVisibilityState = focused ? "visible" : "hidden"): Tab => ({
  url: "http://localhost/",
  focused,
  visibilityState,
  focus: vi.fn(async () => {}),
  postMessage: vi.fn(),
});

describe("service worker: clicking a notification (§34)", () => {
  const handlers = new Map<string, (e: unknown) => void>();
  let tabs: Tab[] = [];
  const openWindow = vi.fn(async () => null);

  beforeAll(async () => {
    const add = vi.spyOn(self, "addEventListener").mockImplementation((type: string, fn: unknown) => {
      handlers.set(type, fn as (e: unknown) => void);
    });
    vi.stubGlobal("clients", { claim: async () => {}, matchAll: async () => tabs, openWindow });
    await import("../../web/src/sw.ts");
    add.mockRestore();
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => openWindow.mockClear());

  async function click(url: unknown) {
    const close = vi.fn();
    let done: Promise<unknown> = Promise.resolve();
    handlers.get("notificationclick")!({ notification: { close, data: { url } }, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    return close;
  }

  it("shows the message in the tab in front, else a visible one, else any", async () => {
    const [behind, visible, front] = [tab(false), tab(false, "visible"), tab(true)];
    tabs = [behind, visible, front];
    const close = await click("/r/a/m/b");
    expect(close).toHaveBeenCalled();
    expect(front.focus).toHaveBeenCalled();
    expect(front.postMessage).toHaveBeenCalledWith({ open: "/r/a/m/b" });
    tabs = [behind, visible];
    await click("/r/c");
    expect(visible.postMessage).toHaveBeenCalledWith({ open: "/r/c" });
    tabs = [behind];
    await click("/r/d");
    expect(behind.postMessage).toHaveBeenCalledWith({ open: "/r/d" });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a new tab when none is open; ignores anything but a path of the app", async () => {
    tabs = [];
    await click("/r/a");
    expect(openWindow).toHaveBeenCalledWith("/r/a");
    openWindow.mockClear();
    await click("https://elsewhere.example/");
    await click("//elsewhere.example/");
    await click("/\\elsewhere.example/");
    await click(undefined);
    expect(openWindow).not.toHaveBeenCalled();
  });
});
