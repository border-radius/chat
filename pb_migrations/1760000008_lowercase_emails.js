/// <reference path="../types/pocketbase.d.ts" />
// QA BUG-47: emails are stored in lower case (pb_hooks lowers new ones), so an address can't make two accounts and
// logging in doesn't depend on its capitalization. Lower the existing ones, except where two accounts already differ
// only in case: those keep their emails, and each still logs in with its own as typed.

migrate(
  (app) => {
    /** @type {Map<string, string[]>} lowered email → ids */
    const byEmail = new Map();
    for (const u of app.findAllRecords("users")) {
      if (!u) continue;
      const key = u.email().trim().toLowerCase();
      byEmail.set(key, [...(byEmail.get(key) ?? []), u.id]);
    }
    for (const [email, ids] of byEmail) {
      if (ids.length !== 1) continue;
      // Raw SQL: no hooks, and `updated` is left alone.
      app.db().newQuery("UPDATE users SET email = {:email} WHERE id = {:id} AND email != {:email}").bind({ email, id: ids[0] }).execute();
    }
  },
  () => {
    // Nothing to undo: the original capitalization isn't kept, and lower-case emails work either way.
  },
);
