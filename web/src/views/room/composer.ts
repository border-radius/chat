// Message composer (§7.6, §17.4): auto-growing textarea, character counter, Enter to send, Shift+Enter for a
// newline, Up arrow in an empty composer to edit your last message, and attachments (picker, paste, drop) shown
// in a tray above the textarea.

import { h } from "../../dom.ts";
import { checkFiles, formatBytes } from "../../lib/files.ts";
import { prepareImage } from "../../lib/image.ts";
import { LIMITS, textLength } from "../../lib/limits.ts";
import type { LocalFile } from "../../lib/types.ts";

const MAX_LEN = LIMITS.messageText;
const COUNTER_FROM = 1800;
const MAX_ROWS = 6;

/** Trimmed text that may be sent or saved, or null. Length in code points, as the server counts it. */
export function validText(raw: string): string | null {
  const t = raw.trim();
  return t.length > 0 && textLength(t) <= MAX_LEN ? t : null;
}

/** Longest edge of an attached image after preparation (§15.3). */
const IMAGE_EDGE = 2048;

/** Images get a preview in the tray (never SVG: it is shown as a file). */
const previewable = (f: File) => f.type.startsWith("image/") && f.type !== "image/svg+xml";

/**
 * Why an edit of `raw` can't be saved, as a sentence; "" when it can. A message with attachments may be left
 * without text (§17.1).
 */
export function editProblem(raw: string, hasFiles = false): string {
  const len = textLength(raw.trim());
  if (len === 0 && !hasFiles) return "A message can't be empty. Use Delete to remove it.";
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
  /** Add attachments (e.g. dropped on the room). Images are prepared first (§15.3). */
  addFiles(files: readonly File[]): Promise<void>;
}

export function createComposer(opts: {
  id: string;
  /**
   * Called with trimmed text (valid, or "" when there are attachments) and the attachments. Return false to
   * refuse (everything stays in the composer). On true, the attachments' preview URLs belong to the caller.
   */
  onSend: (text: string, files: LocalFile[]) => boolean;
  /** Up arrow in an empty composer. Return true if it was handled (an edit started). */
  onEditLast: () => boolean;
  signal: AbortSignal;
}): Composer {
  const { signal } = opts;
  const textarea = h("textarea", { name: "text", rows: 1, id: opts.id, autocomplete: "off" });
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const sendBtn = h("button", { type: "submit", disabled: true }, "Send");
  const fileInput = h("input", {
    id: `${opts.id}-files`,
    type: "file",
    multiple: true,
    class: "visually-hidden",
    tabindex: -1,
    "aria-label": "Attach files",
  });
  const attach = h("button", { type: "button", class: "attach", title: "Attach files", "aria-label": "Attach files" }, "+");
  const tray = h("ul", { class: "tray", "aria-label": "Attachments" });
  const trayError = h("p", { class: "tray-error", role: "alert" });

  let files: LocalFile[] = [];
  /** Attachments still being prepared: Send waits for them. */
  let preparing = 0;

  /** What Send would send: valid text, or attachments with text that isn't too long. */
  function sendable(): string | null {
    const text = validText(textarea.value);
    if (text !== null) return text;
    const t = textarea.value.trim();
    return files.length && textLength(t) <= MAX_LEN ? t : null;
  }

  function onInput() {
    // Count what would be sent (trimmed, in code points), so the counter agrees with the Send button.
    const len = textLength(textarea.value.trim());
    counter.textContent = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;
    fitRows(textarea);
    sendBtn.disabled = preparing > 0 || sendable() === null;
  }

  function renderTray() {
    tray.replaceChildren(
      ...files.map((f) =>
        h("li", { class: "tray-item" }, [
          f.url
            ? h("img", { class: "tray-thumb", src: f.url, width: 40, height: 40, alt: "" })
            : h("span", { class: "tray-icon", "aria-hidden": "true" }, "📄"),
          h("span", { class: "tray-name" }, f.file.name),
          h("span", { class: "tray-size" }, formatBytes(f.file.size)),
          h(
            "button",
            { type: "button", class: "remove", "aria-label": `Remove ${f.file.name}`, on: { click: () => removeFile(f) }, signal },
            "×",
          ),
        ]),
      ),
    );
    tray.hidden = files.length === 0;
    onInput();
  }

  function removeFile(f: LocalFile) {
    if (f.url) URL.revokeObjectURL(f.url);
    files = files.filter((x) => x !== f);
    trayError.textContent = "";
    renderTray();
    textarea.focus();
  }

  async function addFiles(added: readonly File[]) {
    if (!added.length || signal.aborted) return;
    preparing++;
    onInput();
    const prepared = await Promise.all(added.map((f) => (previewable(f) ? prepareImage(f, IMAGE_EDGE) : Promise.resolve(f))));
    preparing--;
    if (signal.aborted) return;
    const { accepted, rejected } = checkFiles(
      files.map((f) => f.file),
      prepared,
    );
    files = [...files, ...accepted.map((file) => ({ file, url: previewable(file) ? URL.createObjectURL(file) : "" }))];
    trayError.textContent = rejected.map((r) => `“${r.name}”: ${r.reason}.`).join(" ");
    renderTray();
  }

  function submit() {
    const text = sendable();
    if (text === null || preparing > 0 || !opts.onSend(text, files)) return;
    textarea.value = "";
    files = []; // the sent message owns their preview URLs now
    trayError.textContent = "";
    renderTray();
  }

  attach.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    () => {
      const picked = [...(fileInput.files ?? [])];
      fileInput.value = "";
      void addFiles(picked);
    },
    { signal },
  );
  textarea.addEventListener(
    "paste",
    (e) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (!pasted.length) return;
      e.preventDefault();
      void addFiles(pasted);
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
    },
    { once: true },
  );

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
    [
      h("div", { class: "tray-wrap" }, [tray, trayError]),
      h("div", { class: "composer-row" }, [
        fileInput,
        attach,
        h("label", { for: opts.id, class: "visually-hidden" }, "Message"),
        textarea,
        counter,
        sendBtn,
      ]),
    ],
  );
  tray.hidden = true;

  return {
    el,
    addFiles,
    setPlaceholder(text) {
      textarea.placeholder = text;
    },
    focus() {
      textarea.focus();
    },
  };
}
