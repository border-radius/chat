import { describe, expect, it } from "vitest";
import { createCache } from "../../web/src/cache.ts";

describe("room cache without IndexedDB (§7.5)", () => {
  it("keeps nothing, and never fails", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    const cache = createCache("test");
    cache.put("u", "r", { items: [], hasOlder: false });
    cache.clear();
    await expect(cache.get("u", "r")).resolves.toBeUndefined();
  });
});
