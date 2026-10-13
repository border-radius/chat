// The room's status line (§22.6): an error stays until something else is said; a confirmation goes away by itself.

import { h } from "../../dom.ts";

/** How long a confirmation such as "Message forwarded." stays on screen (§22.6). */
export const NOTICE_MS = 4000;

export interface Notice {
  readonly el: HTMLElement;
  /** Say `text` until something else is said ("" clears it). */
  say(text: string): void;
  /** Say `text` for NOTICE_MS, unless something else is said meanwhile. */
  flash(text: string): void;
  /** Clear it, if it still says `text`. */
  unsay(text: string): void;
}

export function createNotice(signal: AbortSignal): Notice {
  const el = h("p", { class: "room-notice", role: "status" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", () => clearTimeout(timer));
  const unsay = (text: string) => {
    if (el.textContent === text) el.textContent = "";
  };
  return {
    el,
    say(text) {
      el.textContent = text;
    },
    flash(text) {
      el.textContent = text;
      clearTimeout(timer);
      timer = setTimeout(() => unsay(text), NOTICE_MS);
    },
    unsay,
  };
}
