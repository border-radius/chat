import { describe, expect, it } from "vitest";
import { avatarColor } from "../../../web/src/lib/avatar.ts";
import type { User } from "../../../web/src/lib/types.ts";
import { avatar } from "../../../web/src/ui/avatar.ts";

const url = (u: User, size: number) => (u.avatar ? `/api/files/users/${u.id}/${u.avatar}?thumb=${size}x${size}` : "");

describe("avatar (§15.4)", () => {
  it("renders the thumbnail with fixed size, srcset for 2× screens, lazy, decorative", () => {
    const el = avatar({ id: "u1", name: "Ada", avatar: "a_1234567890.png" }, 32, url) as HTMLImageElement;
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toContain("thumb=48x48");
    expect(el.getAttribute("srcset")).toContain("thumb=96x96 2x");
    expect(el.getAttribute("width")).toBe("32");
    expect(el.getAttribute("height")).toBe("32");
    expect(el.getAttribute("alt")).toBe("");
    expect(el.getAttribute("loading")).toBe("lazy");
  });

  it("uses the 96px thumb for large avatars", () => {
    const el = avatar({ id: "u1", name: "Ada", avatar: "a.png" }, 96, url);
    expect(el.getAttribute("src")).toContain("thumb=96x96");
    expect(el.hasAttribute("srcset")).toBe(false);
  });

  it("shows initials on the user's color without an avatar", () => {
    const el = avatar({ id: "u1", name: "Ada Lovelace" }, 24, url);
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("AL");
    expect(el.classList.contains(`c${avatarColor("u1")}`)).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to initials when the image fails to load", () => {
    const parent = document.createElement("div");
    const img = avatar({ id: "u1", name: "Ada", avatar: "gone.png" }, 32, url);
    parent.append(img);
    img.dispatchEvent(new Event("error"));
    expect(parent.querySelector("img")).toBeNull();
    expect(parent.textContent).toBe("A");
  });
});
