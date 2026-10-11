/// <reference path="../types/pocketbase.d.ts" />
// Forwarding and deleting several messages at once (DESIGN.md §21). `messages.forwarded_from` names who first wrote a
// forwarded message. Only POST /api/chat/forward (pb_hooks) sets it; clients can't set or change it.

const NO_FORWARD = "@request.body.forwarded_from:isset = false";
const LIMITS = [
  { label: "POST /api/chat/forward", audience: "", duration: 60, maxRequests: 20 },
  { label: "POST /api/chat/delete", audience: "", duration: 60, maxRequests: 20 },
];
const LABELS = LIMITS.map((r) => r.label);

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(
      new RelationField(/** @type {any} */ ({ name: "forwarded_from", maxSelect: 1, collectionId: users.id, cascadeDelete: false })),
    );
    messages.createRule = `${messages.createRule} && ${NO_FORWARD}`;
    messages.updateRule = `${messages.updateRule} && ${NO_FORWARD}`;
    app.save(messages);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => !LABELS.includes(r.label));
    settings.rateLimits.rules = [.../** @type {any[]} */ (LIMITS), ...rest];
    app.save(settings);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("forwarded_from");
    messages.createRule = (messages.createRule ?? "").replace(` && ${NO_FORWARD}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_FORWARD}`, "");
    app.save(messages);

    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !LABELS.includes(r.label));
    app.save(settings);
  },
);
