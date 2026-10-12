import { describe, expect, it } from "vitest";
import { BUDGET, checkBudget, formatSizes } from "../../../scripts/lib/build-utils.mjs";

describe("checkBudget", () => {
  it("matches the design doc budget (§7.7)", () => {
    expect(BUDGET).toEqual({ js: 37 * 1024, css: 6 * 1024, html: 1536, viewerJs: 4 * 1024, viewerCss: 1.5 * 1024 });
  });

  it("returns no violations when every asset is under budget", () => {
    expect(checkBudget({ js: 1000, css: 500, html: 300, viewerJs: 1000, viewerCss: 500 })).toEqual([]);
  });

  it("allows an asset exactly at its budget", () => {
    expect(checkBudget({ ...BUDGET })).toEqual([]);
  });

  it("names every asset over budget", () => {
    expect(checkBudget({ js: BUDGET.js + 1, css: 10, html: BUDGET.html + 1, viewerJs: 10, viewerCss: BUDGET.viewerCss + 1 })).toEqual([
      "js",
      "html",
      "viewerCss",
    ]);
  });
});

describe("formatSizes", () => {
  it("prints gzipped KB against the budget and flags violations", () => {
    const out = formatSizes({ js: 2048, css: 6.5 * 1024, html: 512, viewerJs: 1024, viewerCss: 512 });
    expect(out).toContain("js          2.00 KB / 37.00 KB");
    expect(out).toContain("viewerJs    1.00 KB / 4.00 KB");
    expect(out).toMatch(/css\s+6\.50 KB \/ 6\.00 KB\s+OVER/);
    expect(out).not.toMatch(/js .*OVER/);
  });
});
