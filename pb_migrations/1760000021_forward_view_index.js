/// <reference path="../types/pocketbase.d.ts" />
// The messages view rule's forward condition (1760000016_forward_refs.js) as a back-relation, with an index on
// `forward_of`. PocketBase joins `@collection.messages:fwd` without a condition: every expanded message (a page's
// reply_to) was checked against every message there is, times their rooms' members, and a page with replies took
// ~20 s on a busy instance. `messages_via_forward_of` joins on `forward_of = id`, which the index finds at once. Same
// meaning: the "any of" operators all test the same joined forward, as with the alias.

const OLD = "@collection.messages:fwd.";
const NEW = "messages_via_forward_of.";
const INDEX = "CREATE INDEX `idx_messages_forward_of` ON `messages` (`forward_of`)";
/** The alias form's link to this message: the back-relation's join says it. */
const OLD_LINK = `${OLD}forward_of ?= id && `;
const NEW_LINK = `${NEW}id ?!= "" && `;

/**
 * @param {string | null | undefined} rule
 * @param {boolean} up
 */
function rewrite(rule, up) {
  const [fromLink, toLink, from, to] = up ? [OLD_LINK, NEW_LINK, OLD, NEW] : [NEW_LINK, OLD_LINK, NEW, OLD];
  const r = rule ?? "";
  if (!r.includes(fromLink)) throw new Error(`forward view migration: expected ${fromLink} in ${r}`);
  return r.replace(fromLink, toLink).split(from).join(to);
}

/**
 * @param {Parameters<Parameters<typeof migrate>[0]>[0]} app
 * @param {boolean} up
 */
function apply(app, up) {
  const messages = app.findCollectionByNameOrId("messages");
  messages.viewRule = rewrite(messages.viewRule, up);
  const indexes = /** @type {string[]} */ (/** @type {any} */ (messages).indexes).filter((i) => i !== INDEX);
  /** @type {any} */ (messages).indexes = up ? [...indexes, INDEX] : indexes;
  app.save(messages);
}

migrate(
  (app) => apply(app, true),
  (app) => apply(app, false),
);
