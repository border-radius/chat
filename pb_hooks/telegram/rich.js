/// <reference path="../../types/pocketbase.d.ts" />
// Telegram rich messages (Bot API 10.1: Message.rich_message) as a chat message (DESIGN.md §26.4). A rich message has
// no text or caption: its content is a tree of blocks (headings, paragraphs, lists, tables, quotes, media…) holding
// rich text. The room shows plain text (§5), so the blocks become lines of it, and the media in them become files.

/** How deep blocks nest before the rest is left out: Telegram's own are shallow. */
const MAX_DEPTH = 16;

/**
 * Rich text as plain text: a string, an array of rich texts, or a formatted piece (bold, a link…) around one. A link
 * whose text isn't its address keeps the address after it.
 * @param {any} t
 * @returns {string}
 */
function plain(t, depth = 0) {
  if (t == null || depth > MAX_DEPTH) return "";
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map((x) => plain(x, depth + 1)).join("");
  switch (t.type) {
    case "custom_emoji":
      return t.alternative_text || "";
    case "mathematical_expression":
      return t.expression || "";
    case "anchor":
      return "";
    case "button":
      return buttonText(t.button);
    case "url": {
      const text = plain(t.text, depth + 1);
      return !t.url || text.trim() === t.url ? text || t.url || "" : `${text} (${t.url})`;
    }
    default:
      return plain(t.text, depth + 1);
  }
}

/**
 * A button that opens a link, as its text and the link; other buttons (callbacks…) only work in Telegram.
 * @param {any} b RichMessageButton
 */
function buttonText(b) {
  if (!b?.url) return "";
  const text = plain(b.text).trim();
  return text && text !== b.url ? `[${text}: ${b.url}]` : `[${b.url}]`;
}

/** @param {string} prefix @param {string[]} lines */
const prefixed = (prefix, lines) => lines.map((l) => `${prefix}${l}`);

/**
 * A caption (RichBlockCaption) and its credit, as lines.
 * @param {any} c
 */
function captionLines(c) {
  if (!c) return [];
  return [plain(c.text), c.credit ? `— ${plain(c.credit)}` : ""].filter((l) => l.trim()).flatMap((l) => l.split("\n"));
}

/**
 * A rich message's blocks as lines of text; the files in them go to `add` (a Telegram file, its name).
 * @param {any[]} blocks
 * @param {number} n the Telegram message's id, for the names of files that have none
 * @param {(f: any, name: string) => void} add
 * @param {string[]} notes what can't be shown as text or a file
 * @returns {string[]}
 */
function blockLines(blocks, n, add, notes, depth = 0) {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return [];
  /** @type {string[]} */
  const out = [];
  for (const b of blocks) {
    const lines = blockOf(b, n, add, notes, depth);
    // A heading opens a section: a blank line above it, when something came before.
    if (b?.type === "heading" && out.length && out[out.length - 1] !== "") out.push("");
    out.push(...lines);
  }
  return out;
}

/**
 * @param {any} b RichBlock
 * @param {number} n
 * @param {(f: any, name: string) => void} add
 * @param {string[]} notes
 * @param {number} depth
 * @returns {string[]}
 */
function blockOf(b, n, add, notes, depth) {
  if (!b) return [];
  const text = (/** @type {any} */ t) => plain(t).split("\n");
  const inner = (/** @type {any[]} */ blocks) => blockLines(blocks, n, add, notes, depth + 1);
  /** A file of the message: its name, numbered when it has none (a message can hold several). */
  const file = (/** @type {any} */ f, /** @type {string} */ kind, /** @type {string} */ ext) => {
    if (f) add(f, f.file_name || `${kind}_${n}_${seq++}.${ext}`);
    return captionLines(b.caption);
  };
  switch (b.type) {
    case "paragraph":
    case "heading":
    case "footer":
    case "pre":
      return text(b.text);
    case "mathematical_expression":
      return (b.expression || "").split("\n");
    case "divider":
      return ["———"];
    case "anchor":
    case "thinking":
      return [];
    case "list":
      return (b.items || []).flatMap((/** @type {any} */ item) => {
        const box = item.has_checkbox ? (item.is_checked ? "☑ " : "☐ ") : "";
        const label = `${item.label || "•"} ${box}`;
        const lines = inner(item.blocks);
        if (!lines.length) return [label.trimEnd()];
        const indent = " ".repeat([...label].length);
        return [label + lines[0], ...lines.slice(1).map((l) => (l ? indent + l : l))];
      });
    case "blockquote":
      return prefixed("> ", [...inner(b.blocks), ...(b.credit ? [`— ${plain(b.credit)}`] : [])]);
    case "expandable_blockquote":
    case "pullquote":
      return prefixed("> ", [...text(b.text), ...(b.credit ? [`— ${plain(b.credit)}`] : [])]);
    case "collage":
    case "slideshow":
      return [...inner(b.blocks), ...captionLines(b.caption)];
    case "table":
      return [
        ...(b.caption ? text(b.caption) : []),
        ...(b.cells || []).map((/** @type {any[]} */ row) =>
          (row || [])
            .filter((c) => c && c.text != null) // a cell without text is hidden (taken by another's span)
            .map((c) =>
              plain(c.text)
                .replace(/\s*\n\s*/g, " ")
                .trim(),
            )
            .join(" | "),
        ),
      ];
    case "details":
      return [...text(b.summary), ...inner(b.blocks)];
    case "map": {
      const loc = b.location;
      const where = loc ? [`[location: https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}]`] : [];
      return [...where, ...captionLines(b.caption)];
    }
    case "buttons":
      return (b.buttons || []).map(buttonText).filter(Boolean);
    case "photo":
      return file(b.photo?.length ? b.photo[b.photo.length - 1] : null, "photo", "jpg");
    case "video":
      return file(b.video, "video", "mp4");
    case "animation":
      return file(b.animation, "animation", "mp4");
    case "audio":
      return file(b.audio, "audio", "mp3");
    case "voice_note":
      return file(b.voice_note, "voice", "ogg");
    case "document":
      return file(b.document, "file", "bin");
    default:
      // A kind of block newer than this: its text, or what it holds, else a line saying something was left out.
      if (b.text != null) return text(b.text);
      if (Array.isArray(b.blocks)) return inner(b.blocks);
      notes.push(`[${String(b.type || "part").replace(/_/g, " ")}: can't be shown here]`);
      return [];
  }
}

/** Numbers the files without names of the message being read. */
let seq = 1;

/**
 * A Telegram rich message as plain text; its files go to `add`, what can't come over to `notes`.
 * @param {any} rich Message.rich_message
 * @param {number} n the Telegram message's id
 * @param {(f: any, name: string) => void} add
 * @param {string[]} notes
 */
function richText(rich, n, add, notes) {
  seq = 1;
  const lines = blockLines(rich?.blocks, n, add, notes);
  // Runs of blank lines (empty paragraphs, a heading after a gap) as one.
  return lines
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

module.exports = { richText };
