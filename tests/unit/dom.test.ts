import { describe, expect, it, vi } from "vitest";
import { clear, h, on } from "../../web/src/dom.ts";

describe("h()", () => {
  it("creates an element with class, attributes and dataset", () => {
    const el = h("a", { class: "link big", href: "#/r/1", title: "Go", dataset: { id: "m1", roomId: "r1" } });
    expect(el.tagName).toBe("A");
    expect(el.className).toBe("link big");
    expect(el.getAttribute("href")).toBe("#/r/1");
    expect(el.title).toBe("Go");
    expect(el.dataset).toMatchObject({ id: "m1", roomId: "r1" });
    expect(el.getAttribute("data-room-id")).toBe("r1");
  });

  it("boolean attributes: true sets, false/null/undefined omit", () => {
    const el = h("button", { disabled: true, hidden: false, "aria-busy": null, title: undefined });
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("numbers become attribute strings", () => {
    expect(h("textarea", { rows: 3 }).getAttribute("rows")).toBe("3");
  });

  it("form properties (value, checked) are set as properties", () => {
    const input = h("input", { value: "hello" });
    expect(input.value).toBe("hello");
    const box = h("input", { type: "checkbox", checked: true });
    expect(box.checked).toBe(true);
  });

  it("appends nested children in order, skipping null/undefined/false", () => {
    const el = h("div", {}, [h("b", {}, "name"), " says ", null, undefined, false, h("i", {}, ["hi", 2])]);
    expect(el.childNodes).toHaveLength(3);
    expect(el.textContent).toBe("name says hi2");
    expect(el.querySelector("i")!.textContent).toBe("hi2");
  });

  it("accepts a single child", () => {
    expect(h("p", {}, "solo").textContent).toBe("solo");
    expect(h("p").childNodes).toHaveLength(0);
  });

  it("attaches event listeners", () => {
    const click = vi.fn();
    const el = h("button", { on: { click } });
    el.click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("listeners stop after the signal aborts", () => {
    const ac = new AbortController();
    const click = vi.fn();
    const el = h("button", { on: { click }, signal: ac.signal });
    ac.abort();
    el.click();
    expect(click).not.toHaveBeenCalled();
  });

  describe("XSS safety (§7.3)", () => {
    const payload = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

    it("string children become text nodes, never markup", () => {
      const el = h("div", {}, payload);
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector("script")).toBeNull();
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(el.textContent).toBe(payload);
    });

    it("attribute values are not parsed as markup", () => {
      const el = h("div", { title: payload });
      expect(el.children).toHaveLength(0);
      expect(el.title).toBe(payload);
    });
  });
});

describe("clear()", () => {
  it("removes all children", () => {
    const el = h("ul", {}, [h("li", {}, "a"), h("li", {}, "b"), "text"]);
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});

describe("on()", () => {
  it("adds a listener that stops after abort", () => {
    const ac = new AbortController();
    const fn = vi.fn();
    const target = new EventTarget();
    on(target, "ping", fn, ac.signal);
    target.dispatchEvent(new Event("ping"));
    ac.abort();
    target.dispatchEvent(new Event("ping"));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
