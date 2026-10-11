import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthStore, createClient, PbError } from "../../web/src/pb.ts";

/** An unsigned JWT with `payload` (only the client's expiry check reads it). Base64url, like PocketBase's. */
const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.x`;
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const user = { id: "u1", collectionName: "users", name: "Ada" };

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("auth store", () => {
  it("is valid only with an unexpired token", () => {
    const store = createAuthStore();
    expect(store.isValid).toBe(false);
    store.save(jwt({ exp: inAnHour() }), user);
    expect(store.isValid).toBe(true);
    store.save(jwt({ exp: Math.floor(Date.now() / 1000) - 1 }), user);
    expect(store.isValid).toBe(false);
    store.save("not-a-jwt", user);
    expect(store.isValid).toBe(false);
  });

  it("tells when the token expires (QA BUG-45: the app renews it in time)", () => {
    const store = createAuthStore();
    expect(store.expiresAt).toBe(0);
    const exp = inAnHour();
    store.save(jwt({ exp }), user);
    expect(store.expiresAt).toBe(exp * 1000);
    store.clear();
    expect(store.expiresAt).toBe(0);
  });

  it("reads base64url tokens (a payload with - or _ in it)", () => {
    const store = createAuthStore();
    // "?>?" encodes to "Pz4/" in base64: "/" becomes "_" in base64url.
    store.save(jwt({ exp: inAnHour(), x: "?>?" }), user);
    expect(store.isValid).toBe(true);
  });

  it("persists to storage under the SDK's key, so existing sessions survive", () => {
    const token = jwt({ exp: inAnHour() });
    createAuthStore(localStorage).save(token, user);
    expect(JSON.parse(localStorage.getItem("pocketbase_auth")!)).toEqual({ token, record: user });
    const reloaded = createAuthStore(localStorage);
    expect(reloaded.token).toBe(token);
    expect(reloaded.record).toEqual(user);
    reloaded.clear();
    expect(localStorage.getItem("pocketbase_auth")).toBeNull();
  });

  it("follows another tab's save and clear through the storage event", () => {
    const store = createAuthStore(localStorage);
    const changed = vi.fn();
    store.onChange(changed);
    const token = jwt({ exp: inAnHour() });
    const newValue = JSON.stringify({ token, record: user });
    dispatchEvent(new StorageEvent("storage", { key: "pocketbase_auth", newValue }));
    expect(store.record).toEqual(user);
    expect(changed).toHaveBeenCalledTimes(1);
    dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "{}" }));
    expect(changed).toHaveBeenCalledTimes(1);
    dispatchEvent(new StorageEvent("storage", { key: "pocketbase_auth", newValue: null }));
    expect(store.token).toBe("");
    expect(store.record).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("stops calling a listener once unsubscribed", () => {
    const store = createAuthStore();
    const changed = vi.fn();
    const off = store.onChange(changed);
    store.clear();
    off();
    store.clear();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("client", () => {
  const pb = createClient("http://pb.test/");

  it("binds filter params as quoted, escaped literals and leaves unknown placeholders alone", () => {
    expect(pb.filter("a = {:s} && b = {:n} && c = {:b} && d = {:x} && e = {:missing}", { s: `x" || "`, n: 3, b: true, x: null })).toBe(
      `a = "x\\" || \\"" && b = 3 && c = true && d = null && e = {:missing}`,
    );
  });

  it("builds file URLs with encoded parts and only the query values given", () => {
    expect(pb.fileUrl("messages", "m1", "a b.png", { thumb: "240x180", token: undefined })).toBe(
      "http://pb.test/api/files/messages/m1/a%20b.png?thumb=240x180",
    );
  });

  function stubFetch(status: number, body: unknown) {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sends JSON with the auth token, and the query encoded", async () => {
    const fetch = stubFetch(200, { ok: 1 });
    pb.authStore.save("tok", user);
    expect(await pb.send("/api/x", { method: "POST", query: { filter: "a = 1", skipTotal: true }, body: { a: null } })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://pb.test/api/x?filter=a%20%3D%201&skipTotal=true");
    expect(init.headers).toEqual({ Authorization: "tok", "Content-Type": "application/json" });
    expect(init.body).toBe(`{"a":null}`);
    pb.authStore.clear();
  });

  it("sends a body holding files as multipart: files and strings as fields, the rest as @jsonPayload", async () => {
    const fetch = stubFetch(200, {});
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    await pb.send("/api/x", { method: "POST", body: { text: "hi", files: [a, b], n: 2 } });
    const form = fetch.mock.calls[0]![1].body as FormData;
    expect(form.get("text")).toBe("hi");
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual(["a.txt", "b.txt"]);
    expect(form.get("@jsonPayload")).toBe(`{"n":2}`);
    expect(fetch.mock.calls[0]![1].headers).toEqual({});
  });

  it("rejects with the server's message, status and field errors", async () => {
    stubFetch(400, { message: "Failed to create record.", data: { name: { code: "validation_required", message: "Missing." } } });
    const err = await pb.send("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbError);
    expect(err).toMatchObject({ status: 400, message: "Failed to create record.", isAbort: false });
    expect((err as PbError).response.data?.name).toEqual({ code: "validation_required", message: "Missing." });
  });

  it("rejects with status 0 on network trouble, and marks aborts", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await pb.send("/api/x").catch((e: unknown) => e)).toMatchObject({ status: 0, isAbort: false });
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal("fetch", async () => Promise.reject(new DOMException("aborted", "AbortError")));
    expect(await pb.send("/api/x", { signal: ac.signal }).catch((e: unknown) => e)).toMatchObject({ status: 0, isAbort: true });
  });
});
