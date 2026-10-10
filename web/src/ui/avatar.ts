// A user's avatar (§15.4): their picture through a thumbnail, or initials on a color picked from their id.
// Decorative (alt="", aria-hidden initials): it is always shown next to the user's name.

import type { AvatarSize } from "../api.ts";
import { h } from "../dom.ts";
import { avatarColor, initials } from "../lib/avatar.ts";
import type { User } from "../lib/types.ts";

/** Rendered sizes in CSS px (`.avatar.s24` … in app.css). */
export type AvatarPx = 24 | 32 | 96;

export type AvatarUrl = (user: User, size: AvatarSize) => string;

function initialsEl(user: User, px: AvatarPx): HTMLElement {
  return h("span", { class: `avatar initials s${px} c${avatarColor(user.id)}`, "aria-hidden": "true" }, initials(user.name));
}

export function avatar(user: User, px: AvatarPx, url: AvatarUrl): HTMLElement {
  const src = url(user, px > 48 ? 96 : 48);
  if (!src) return initialsEl(user, px);
  const img = h("img", {
    class: `avatar s${px}`,
    src,
    srcset: px <= 48 ? `${src} 1x, ${url(user, 96)} 2x` : undefined,
    width: px,
    height: px,
    alt: "",
    loading: "lazy",
    decoding: "async",
  });
  // A missing or broken file: fall back to initials, once.
  img.addEventListener("error", () => img.replaceWith(initialsEl(user, px)), { once: true });
  return img;
}
