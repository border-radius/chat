import { describe, expect, it } from "vitest";
import { captureAnchor, isNearBottom, restoreAnchor } from "../../../web/src/lib/scroll.ts";
import { fakeLayout } from "../../support/dom.ts";

describe("isNearBottom (§7.5: stick to bottom within 80px)", () => {
  it("is true within the threshold and false beyond it", () => {
    expect(isNearBottom({ scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 1520, scrollHeight: 2000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 1519, scrollHeight: 2000, clientHeight: 400 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 2000, clientHeight: 400 })).toBe(false);
  });

  it("content shorter than the viewport counts as at the bottom", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

describe("scroll anchoring (§7.5)", () => {
  const ROW = 40;

  function setup(count: number, scrollTop: number) {
    const list = document.createElement("ol");
    for (let i = 0; i < count; i++) {
      const li = document.createElement("li");
      li.dataset.id = `m${i}`;
      list.append(li);
    }
    const layout = fakeLayout(list, { rowHeight: ROW, clientHeight: 400, scrollTop });
    return { list, layout };
  }

  it("captures the first element at or below the scroll position", () => {
    const { list } = setup(50, 10 * ROW + 5);
    const a = captureAnchor(list, "[data-id]")!;
    expect(a.el.dataset.id).toBe("m11");
    expect(a.offset).toBe(11 * ROW - (10 * ROW + 5));
  });

  it("keeps the anchor on screen after prepending 50 rows", () => {
    const { list } = setup(50, 10 * ROW);
    const a = captureAnchor(list, "[data-id]")!;
    for (let i = 0; i < 50; i++) {
      const li = document.createElement("li");
      li.dataset.id = `old${i}`;
      list.prepend(li);
    }
    restoreAnchor(list, a);
    expect(list.scrollTop).toBe((50 + 10) * ROW);
    expect(a.el.offsetTop - list.scrollTop).toBe(a.offset);
  });

  it("keeps the anchor on screen after trimming rows above it", () => {
    const { list } = setup(100, 60 * ROW);
    const a = captureAnchor(list, "[data-id]")!;
    for (let i = 0; i < 30; i++) list.firstElementChild!.remove();
    restoreAnchor(list, a);
    expect(list.scrollTop).toBe(30 * ROW);
  });

  it("finds the anchor again by data-id when its element was replaced by a re-render", () => {
    const { list } = setup(50, 0);
    const a = captureAnchor(list, "[data-id]")!;
    expect(a.el.dataset.id).toBe("m0");
    const replacement = document.createElement("li");
    replacement.dataset.id = "m0";
    a.el.replaceWith(replacement);
    for (let i = 0; i < 50; i++) {
      const li = document.createElement("li");
      li.dataset.id = `old${i}`;
      list.prepend(li);
    }
    restoreAnchor(list, a);
    expect(list.scrollTop).toBe(50 * ROW);
  });

  it("returns null when there is nothing to anchor to", () => {
    const { list } = setup(0, 0);
    expect(captureAnchor(list, "[data-id]")).toBeNull();
  });

  it("restoring a detached anchor does nothing", () => {
    const { list } = setup(20, 5 * ROW);
    const a = captureAnchor(list, "[data-id]")!;
    a.el.remove();
    restoreAnchor(list, a);
    expect(list.scrollTop).toBe(5 * ROW);
  });
});
