// Message composer (§7.6): auto-growing textarea, character counter, Enter to send, Shift+Enter for a newline,
// Up arrow in an empty composer to edit your last message.

import { h } from "../../dom.ts";
import { LIMITS, textLength } from "../../lib/limits.ts";

const MAX_LEN = LIMITS.messageText;
const COUNTER_FROM = 1800;
const MAX_ROWS = 6;

/** Trimmed text that may be sent or saved, or null. Length in code points, as the server counts it. */
export function validText(raw: string): string | null {
  const t = raw.trim();
  return t.length > 0 && textLength(t) <= MAX_LEN ? t : null;
}

/** Why an edit of `raw` can't be saved, as a sentence; "" when it can. */
export function editProblem(raw: string): string {
  const len = textLength(raw.trim());
  if (len === 0) return "A message can't be empty. Use Delete to remove it.";
  return len > MAX_LEN ? `Too long: ${len - MAX_LEN} characters over the ${MAX_LEN} limit.` : "";
}

/** Rows for a textarea showing `text` (grows with its lines, up to 6). */
export const rowsFor = (text: string) => Math.min(MAX_ROWS, text.split("\n").length);

/**
 * Size a textarea to its content, up to 6 rows, counting lines that wrap as well as explicit newlines.
 * Without layout (scrollHeight 0, e.g. in tests) it falls back to counting newlines.
 */
export function fitRows(t: HTMLTextAreaElement): void {
  t.rows = 1;
  const style = getComputedStyle(t);
  const line = Number.parseFloat(style.lineHeight) || 1.2 * (Number.parseFloat(style.fontSize) || 16);
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const wrapped = t.scrollHeight > 0 ? Math.round((t.scrollHeight - padding) / line) : 0;
  t.rows = Math.min(MAX_ROWS, Math.max(rowsFor(t.value), wrapped, 1));
}

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
    // Count what would be sent (trimmed, in code points), so the counter agrees with the Send button.
    const len = textLength(textarea.value.trim());
    counter.textContent = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;
    fitRows(textarea);
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
