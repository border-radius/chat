// Home (§7.1): what the pane next to the room list shows when no room is open. A guest is told what they can read and
// how to join in (§23.3).

import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function createHomeView({ store }: Pick<Ctx, "store">): View {
  const scope = createScope();
  let root: HTMLElement;
  const title = h("h1", {});
  const text = h("p", {});
  const render = () => {
    const user = store.get().user;
    const name = firstName(user?.name ?? "");
    title.textContent = name ? `Welcome, ${name}!` : "Welcome!";
    if (user) text.replaceChildren("Pick a room or a conversation from the list, or start a new one.");
    else
      text.replaceChildren(
        "Read any of the Open Air rooms in the list, no account needed. ",
        h("a", { href: "#/login" }, "Log in"),
        " or ",
        h("a", { href: "#/signup" }, "sign up"),
        " to join the conversation.",
      );
  };

  return {
    mount(el) {
      root = el;
      render();
      clear(root);
      root.append(h("section", { class: "welcome" }, [title, text]));
      scope.defer(
        store.subscribe((s, prev) => {
          if (s.user !== prev.user) render();
        }),
      );
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
