/// <reference path="../../types/pocketbase.d.ts" />
// Cleaning and comparing user-written text (names, messages, file names). Pure string functions, no records.

/**
 * Invisible format characters: zero-width spaces and joiners, bidi marks/overrides/isolates, word joiners,
 * BOM, soft hyphen. `String.trim()` keeps them, so text made only of these would look empty.
 */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Removed from names (users, rooms): never needed there, and used to spoof ("‮admin", "general​").
 * ZWNJ/ZWJ (U+200C/D) stay: some scripts and emoji sequences need them.
 */
const NAME_JUNK = /[­᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Control characters (tabs, line breaks, C1) and line/paragraph separators: shown as spaces, if at all (QA BUG-38). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Longest original file name kept, in UTF-8 bytes. PocketBase stores the original name as file metadata cut at
 * 255 bytes, which can split a character and then fails the whole upload (QA BUG-35).
 */
const MAX_FILE_NAME_BYTES = 200;

/** @param {string} s */
const isBlank = (s) => s.replace(INVISIBLE, "").trim() === "";

/**
 * A name as it should be shown: no invisible/bidi characters, control characters as spaces, every run of
 * whitespace as one space, trimmed. Names that look the same are then the same (QA BUG-38).
 * @param {string} s
 */
const tidy = (s) => s.replace(NAME_JUNK, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();

/** @param {string} s */
const utf8Length = (s) => {
  let n = 0;
  for (const c of s) {
    const cp = c.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

/**
 * `name` cut to at most `max` UTF-8 bytes on a character boundary, keeping its extension (QA BUG-36).
 * @param {string} name
 * @param {number} [max]
 */
function clipFileName(name, max = MAX_FILE_NAME_BYTES) {
  if (utf8Length(name) <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  let stem = "";
  let n = utf8Length(ext);
  for (const c of name.slice(0, name.length - ext.length)) {
    n += utf8Length(c);
    if (n > max) break;
    stem += c;
  }
  return stem.trimEnd() + ext;
}

/**
 * Uniqueness key for room and display names: NFKC + full case folding (via upper→lower, so "ß" matches "SS" and "Ü"
 * "ü"), without invisible characters. Keep in sync with pb_migrations/1760000001_qa_fixes.js and
 * 1760000012_accounts.js.
 * @param {string} name
 */
function nameKey(name) {
  const s = name.replace(INVISIBLE, "");
  return (typeof s.normalize === "function" ? s.normalize("NFKC") : s).toUpperCase().toLowerCase();
}

/**
 * Leading "#"s of a room name: rooms are shown as "#name", so "#general" would read "##general", next to a
 * different "general" (QA BUG-48).
 * @param {string} name
 */
const stripHashes = (name) => name.replace(/^[#\s]+/, "");

/**
 * An upload's name as the user's file is called. Browsers send `"` as "%22" (and line breaks as "%0D"/"%0A") in a
 * multipart file name, per the HTML spec, so "Q&A "v2".txt" arrived as "Q&A %22v2%22.txt" (QA BUG-54).
 * @param {string} name
 */
const unescapeUploadName = (name) => name.replace(/%22/g, '"').replace(/%0[AD]/gi, " ");

module.exports = { isBlank, tidy, clipFileName, nameKey, stripHashes, unescapeUploadName };
