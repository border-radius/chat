import { describe, expect, it, vi } from "vitest";
import { createScope } from "../../web/src/scope.ts";

describe("createScope", () => {
  it("is active until disposed, and aborts its signal on dispose", () => {
    const scope = createScope();
    expect(scope.active).toBe(true);
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
    expect(scope.active).toBe(false);
    expect(scope.signal.aborted).toBe(true);
  });

  it("runs deferred cleanups once, newest first", () => {
    const scope = createScope();
    const log: string[] = [];
    scope.defer(() => log.push("a"));
    scope.defer(() => log.push("b"));
    scope.dispose();
    scope.dispose();
    expect(log).toEqual(["b", "a"]);
  });

  it("a throwing cleanup doesn't stop the others", () => {
    const scope = createScope();
    const after = vi.fn();
    scope.defer(after);
    scope.defer(() => {
      throw new Error("boom");
    });
    scope.dispose();
    expect(after).toHaveBeenCalledOnce();
  });

  it("defer() after dispose runs immediately", () => {
    const scope = createScope();
    scope.dispose();
    const fn = vi.fn();
    scope.defer(fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("sub() unsubscribes on dispose, even if the subscription resolves later", async () => {
    const scope = createScope();
    const off = vi.fn(async () => {});
    let resolve!: (fn: typeof off) => void;
    scope.sub(new Promise((r) => (resolve = r)));
    scope.dispose();
    expect(off).not.toHaveBeenCalled();
    resolve(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledOnce());
  });

  it("sub() swallows a failed subscription", async () => {
    const scope = createScope();
    scope.sub(Promise.reject(new Error("offline")));
    scope.dispose();
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });

  it("sub() swallows a subscription that fails while the scope is still active", async () => {
    const scope = createScope();
    scope.sub(Promise.reject(new Error("offline")));
    await new Promise((r) => setTimeout(r, 0)); // unhandled until dispose would fail the run here
    scope.dispose();
  });

  it("listeners registered with its signal stop on dispose", () => {
    const scope = createScope();
    const target = new EventTarget();
    const fn = vi.fn();
    target.addEventListener("ping", fn, { signal: scope.signal });
    target.dispatchEvent(new Event("ping"));
    scope.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(fn).toHaveBeenCalledOnce();
  });
});
