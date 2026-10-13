// Replying (§19): the message the composer is replying to, kept in step with it. Edited, the quote shows the new text;
// deleted (or the room archived), there is nothing left to reply to.

import { quoteText } from "../../lib/messages.ts";
import type { Message } from "../../lib/types.ts";
import type { Composer } from "./composer.ts";

export interface Reply {
  /** The message being replied to, or null. */
  readonly to: Message | null;
  set(m: Message | null): void;
  /** Reply to message `id`, if it can be replied to, and put the caret in the composer. */
  start(id: string): void;
  /** Follow the message after the list changed. Out of the window, it is checked against the room alone. */
  refresh(): void;
}

export function createReply(opts: {
  find: (id: string) => Message | undefined;
  repliable: (m: Message) => boolean;
  composer: Pick<Composer, "setReply" | "focus">;
}): Reply {
  const { composer } = opts;
  let to: Message | null = null;

  function set(m: Message | null) {
    to = m;
    composer.setReply(m && { name: m.expand?.author?.name ?? "Unknown", text: quoteText(m) });
  }

  return {
    get to() {
      return to;
    },
    set,
    start(id) {
      const m = opts.find(id);
      if (!m || !opts.repliable(m)) return;
      set(m);
      composer.focus();
    },
    refresh() {
      if (!to) return;
      const now = opts.find(to.id) ?? to;
      if (!opts.repliable(now)) set(null);
      else if (now !== to) set(now);
    },
  };
}
