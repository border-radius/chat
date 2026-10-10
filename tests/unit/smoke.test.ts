import { describe, expect, it } from "vitest";

describe("unit harness", () => {
  it("runs", () => {
    expect(1).toBe(1);
  });

  it("has a DOM", () => {
    const el = document.createElement("div");
    el.textContent = "hi";
    expect(el.outerHTML).toBe("<div>hi</div>");
  });
});
