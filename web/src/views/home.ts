// Home (§7.1): what the pane next to the room list shows when no room is open.

import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function createHomeView({ store }: Pick<Ctx, "store">): View {
  const scope = createScope();
  let root: HTMLElement;
  const title = h("h1", {});
  const render = () => {
    const name = firstName(store.get().user?.name ?? "");
    title.textContent = name ? `Welcome, ${name}!` : "Welcome!";
  };

  return {
    mount(el) {
      root = el;
      render();
      clear(root);
      root.append(h("section", { class: "welcome" }, [title, h("p", {}, "Pick a room or a conversation from the list, or start a new one.")]));
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
