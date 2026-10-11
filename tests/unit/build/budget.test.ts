import { describe, expect, it } from "vitest";
import { BUDGET, checkBudget, formatSizes } from "../../../scripts/lib/build-utils.mjs";

describe("checkBudget", () => {
  it("matches the design doc budget (§7.7)", () => {
    expect(BUDGET).toEqual({ js: 32 * 1024, css: 5.5 * 1024, html: 1536 });
  });

  it("returns no violations when every asset is under budget", () => {
    expect(checkBudget({ js: 1000, css: 500, html: 300 })).toEqual([]);
  });

  it("allows an asset exactly at its budget", () => {
    expect(checkBudget({ ...BUDGET })).toEqual([]);
  });

  it("names every asset over budget", () => {
    expect(checkBudget({ js: BUDGET.js + 1, css: 10, html: BUDGET.html + 1 })).toEqual(["js", "html"]);
  });
});

describe("formatSizes", () => {
  it("prints gzipped KB against the budget and flags violations", () => {
    const out = formatSizes({ js: 2048, css: 6 * 1024, html: 512 });
    expect(out).toContain("js    2.00 KB / 32.00 KB");
    expect(out).toMatch(/css\s+6\.00 KB \/ 5\.50 KB\s+OVER/);
    expect(out).not.toMatch(/js .*OVER/);
  });
});
