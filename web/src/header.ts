// The app bar (§7.1): the site's logo and title (§24), then who is logged in (a link to the profile, §22.2) or, for a
// guest, the way in (§23.3). Drawn again when the site or the user changes.

import type { Api } from "./api.ts";
import { clear, h } from "./dom.ts";
import type { AppState, Store } from "./store.ts";
import { avatar } from "./ui/avatar.ts";

export function createHeader({ api, store }: { api: Api; store: Store<AppState> }): { el: HTMLElement; stop: () => void } {
  const el = h("header", { class: "app-bar" });

  function brand() {
    const { title, logo } = store.get().site;
    return h("a", { href: "/", class: logo ? "brand has-logo" : "brand" }, [
      logo ? h("img", { src: logo, alt: "", class: "brand-logo" }) : null,
      h("span", { class: "brand-title" }, title),
    ]);
  }

  function render() {
    const user = store.get().user;
    clear(el);
    if (!user) {
      el.append(
        brand(),
        h("nav", { class: "guest-links", "aria-label": "Account" }, [
          h("a", { href: "/login", class: "guest-link" }, "Log in"),
          h("a", { href: "/signup", class: "guest-link primary" }, "Sign up"),
        ]),
      );
      return;
    }
    el.append(
      brand(),
      h("a", { href: "/me", class: "me-link", title: "Your profile" }, [
        avatar(user, 24, api.avatarUrl),
        h("span", { class: "who" }, user.name),
      ]),
    );
  }

  const stop = store.subscribe((s, prev) => {
    if (s.site !== prev.site || s.user !== prev.user) render();
  });
  render();
  return { el, stop };
}
