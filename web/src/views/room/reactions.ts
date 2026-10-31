// Reactions on a message (§20.3): a chip per emoji with how many reacted and who, and the buttons that open the emoji
// picker to add one. What reacting *does* is up to the room view.

import { h } from "../../dom.ts";
import type { Message, Reaction } from "../../lib/types.ts";

/** A reaction as shown: with who reacted, in words. */
export type ShownReaction = Reaction & { who: string };

/** Where focus goes in a message after its reactions change: the reaction, else the buttons that add one. */
export const reactionFocus = (emoji: string): readonly string[] => [
  `.reactions [data-emoji="${CSS.escape(emoji)}"]`,
  ".reactions .add-reaction",
  ".actions .react",
];

export interface ReactionParts {
  /** The message's reactions row. */
  row(m: Message, reactions: readonly ShownReaction[], reactable: boolean, me: string): HTMLElement;
  /** "Add reaction" for message `id`, with class `cls`. */
  addButton(id: string, cls: string): HTMLButtonElement;
}

export function createReactionParts(opts: {
  /** A reaction chip was clicked: add (`on`) or take back my `emoji`. */
  onReact: (id: string, emoji: string, on: boolean) => void;
  /** React (or a reactions row's +) was clicked: offer the emoji picker next to `opener`. */
  onPickReaction: (id: string, opener: HTMLElement) => void;
  signal: AbortSignal;
}): ReactionParts {
  const { signal } = opts;

  /** "Add reaction": opens the emoji picker for a reaction to message `id`. */
  function addButton(id: string, cls: string): HTMLButtonElement {
    const label = "Add reaction";
    const b: HTMLButtonElement = h("button", {
      type: "button",
      class: `${cls} ic i-react`,
      title: label,
      "aria-label": label,
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      on: { click: () => opts.onPickReaction(id, b) },
      signal,
    });
    return b;
  }

  /**
   * The emoji people reacted with, each with how many (§20.3). Where I can react, each one is a toggle for mine, and a
   * last button adds another; otherwise (an archived room) they only show.
   */
  function row(m: Message, reactions: readonly ShownReaction[], reactable: boolean, me: string): HTMLElement {
    const chips = reactions.map((r) => {
      const mine = r.users.includes(me);
      const n = r.users.length;
      const content = [h("span", { class: "reaction-emoji" }, r.emoji), h("span", { class: "reaction-count" }, String(n))];
      const attrs = { class: `reaction${mine ? " mine" : ""}`, title: `${r.who} reacted with ${r.emoji}`, dataset: { emoji: r.emoji } };
      if (!reactable) return h("span", attrs, content);
      return h(
        "button",
        {
          ...attrs,
          type: "button",
          "aria-pressed": String(mine),
          "aria-label": `${r.emoji} ${n} ${n === 1 ? "reaction" : "reactions"}`,
          on: { click: () => opts.onReact(m.id, r.emoji, !mine) },
          signal,
        },
        content,
      );
    });
    return h("div", { class: "reactions", role: "group", "aria-label": "Reactions" }, [
      ...chips,
      reactable ? addButton(m.id, "add-reaction") : null,
    ]);
  }

  return { row, addButton };
}
