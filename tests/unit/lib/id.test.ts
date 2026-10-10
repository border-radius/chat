import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../../web/src/lib/id.ts";

describe("newId (§7.5)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is a 15-char PocketBase-compatible id", () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(/^[a-z0-9]{15}$/);
  });

  it("has no collisions in 10,000 ids", () => {
    const ids = new Set(Array.from({ length: 10_000 }, newId));
    expect(ids.size).toBe(10_000);
  });

  it("uses crypto.getRandomValues, not Math.random", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    const rnd = vi.spyOn(Math, "random");
    newId();
    expect(spy).toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
  });

  it("covers the whole alphabet without bias toward early characters", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i++) for (const c of newId()) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(36);
    // 150,000 chars / 36 ≈ 4167 each (σ ≈ 64). Naive `byte % 36` gives a–d 8/256 ≈ 4688: outside ±5σ.
    for (const n of counts.values()) expect(n).toBeGreaterThan(3_847);
    for (const n of counts.values()) expect(n).toBeLessThan(4_487);
  });
});
