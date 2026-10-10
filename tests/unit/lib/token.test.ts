import { describe, expect, it, vi } from "vitest";
import { createTokenCache, TOKEN_MAX_AGE_MS } from "../../../web/src/lib/token.ts";

describe("file token cache (§17.3)", () => {
  function setup() {
    let t = 0;
    let n = 0;
    const fetchToken = vi.fn(async () => `token-${++n}`);
    const cache = createTokenCache(fetchToken, () => t);
    return { cache, fetchToken, advance: (ms: number) => (t += ms) };
  }

  it("fetches once, then reuses the token while it is fresh", async () => {
    const { cache, fetchToken, advance } = setup();
    expect(cache.current()).toBe("");
    expect(await cache.ensure()).toBe("token-1");
    advance(TOKEN_MAX_AGE_MS - 1);
    expect(await cache.ensure()).toBe("token-1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes after 2 minutes, keeping the old one available meanwhile", async () => {
    const { cache, advance } = setup();
    await cache.ensure();
    advance(TOKEN_MAX_AGE_MS);
    expect(cache.fresh()).toBe(false);
    expect(cache.current()).toBe("token-1");
    expect(await cache.ensure()).toBe("token-2");
  });

  it("shares one request between concurrent callers; force fetches a new one", async () => {
    const { cache, fetchToken } = setup();
    const [x, y] = await Promise.all([cache.ensure(), cache.ensure()]);
    expect([x, y]).toEqual(["token-1", "token-1"]);
    expect(await cache.ensure(true)).toBe("token-2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("reset forgets the token, and a fetch started before it doesn't come back", async () => {
    const { cache } = setup();
    const before = cache.ensure();
    cache.reset();
    await before;
    expect(cache.current()).toBe("");
    expect(await cache.ensure()).toBe("token-2");
  });

  it("a failed fetch can be retried", async () => {
    const fetchToken = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ok");
    const cache = createTokenCache(fetchToken);
    await expect(cache.ensure()).rejects.toThrow("offline");
    expect(await cache.ensure()).toBe("ok");
  });
});
