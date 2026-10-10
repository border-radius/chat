// Message composer (§7.6): auto-growing textarea, character counter, Enter to send, Shift+Enter for a newline,
// Up arrow in an empty composer to edit your last message.

import { h } from "../../dom.ts";
import { LIMITS } from "../../lib/limits.ts";

const MAX_LEN = LIMITS.messageText;
const COUNTER_FROM = 1800;
const MAX_ROWS = 6;

/** Trimmed text that may be sent or saved, or null. */
export function validText(raw: string): string | null {
  const t = raw.trim();
  return t.length > 0 && t.length <= MAX_LEN ? t : null;
}

/** Rows for a textarea showing `text` (grows with its lines, up to 6). */
export const rowsFor = (text: string) => Math.min(MAX_ROWS, text.split("\n").length);

export interface Composer {
  readonly el: HTMLFormElement;
  setPlaceholder(text: string): void;
  focus(): void;
}

export function createComposer(opts: {
  id: string;
  /** Called with valid, trimmed text. Return false to refuse it (the text then stays in the composer). */
  onSend: (text: string) => boolean;
  /** Up arrow in an empty composer. Return true if it was handled (an edit started). */
  onEditLast: () => boolean;
  signal: AbortSignal;
}): Composer {
  const { signal } = opts;
  const textarea = h("textarea", { name: "text", rows: 1, id: opts.id, autocomplete: "off" });
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const sendBtn = h("button", { type: "submit", disabled: true }, "Send");

  function onInput() {
    const len = textarea.value.length;
    counter.textContent = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;
    textarea.rows = rowsFor(textarea.value);
    sendBtn.disabled = validText(textarea.value) === null;
  }

  function submit() {
    const text = validText(textarea.value);
    if (text === null || !opts.onSend(text)) return;
    textarea.value = "";
    onInput();
  }

  textarea.addEventListener("input", onInput, { signal });
  textarea.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === "ArrowUp" && textarea.value === "" && opts.onEditLast()) {
        e.preventDefault();
      }
    },
    { signal },
  );

  const el = h(
    "form",
    {
      class: "composer",
      on: {
        submit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      signal,
    },
    [h("label", { for: opts.id, class: "visually-hidden" }, "Message"), textarea, counter, sendBtn],
  );

  return {
    el,
    setPlaceholder(text) {
      textarea.placeholder = text;
    },
    focus() {
      textarea.focus();
    },
  };
}
