/// <reference path="../types/pocketbase.d.ts" />
// One device, several accounts (docs/ANDROID.md §17.4): the app registers the device's push token once per account, so
// two accounts on this server share a token. A token is now unique per user, not overall.

const PER_TOKEN = "CREATE UNIQUE INDEX idx_push_tokens_token ON push_tokens (token)";
const PER_USER = "CREATE UNIQUE INDEX idx_push_tokens_token_user ON push_tokens (token, user)";

/**
 * @param {Parameters<Parameters<typeof migrate>[0]>[0]} app
 * @param {string} from
 * @param {string} to
 */
function swap(app, from, to) {
  const c = /** @type {any} */ (app.findCollectionByNameOrId("push_tokens"));
  c.indexes = [.../** @type {string[]} */ (c.indexes).filter((i) => i !== from), to];
  app.save(c);
}

migrate(
  (app) => swap(app, PER_TOKEN, PER_USER),
  (app) => {
    // Back to one row per token: the newest registration of each keeps it.
    app
      .db()
      .newQuery(
        "DELETE FROM push_tokens WHERE id NOT IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY token ORDER BY updated DESC, id DESC) AS n FROM push_tokens) WHERE n = 1)",
      )
      .execute();
    swap(app, PER_USER, PER_TOKEN);
  },
);
