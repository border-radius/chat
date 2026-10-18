/// <reference path="../types/pocketbase.d.ts" />
// Message search (DESIGN.md §29): "İ" is searched as "i" (QA BUG-113). Lowercased, "İ" is "i" followed by a combining
// dot above (U+0307), so the key of "İstanbul" was "i̇stanbul", which "istanbul" as typed never matched. The hooks now
// drop that dot (`searchKey` in pb_hooks/lib/text.js); this does the same to the keys already stored.

migrate(
  (app) => {
    app
      .db()
      .newQuery("UPDATE messages SET text_key = replace(text_key, 'i' || char(775), 'i') WHERE instr(text_key, 'i' || char(775)) > 0")
      .execute();
  },
  () => {
    // Nothing to undo: a key without the dot finds what it found before, and more.
  },
);
