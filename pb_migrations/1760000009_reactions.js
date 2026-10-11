/// <reference path="../types/pocketbase.d.ts" />
// Reactions (DESIGN.md §20.1): `messages.reactions` lists each emoji with who reacted with it. Only
// POST /api/chat/reactions (pb_hooks) writes it; clients can't set it on create or update.

const NO_REACTIONS = "@request.body.reactions:isset = false";
const REACT_LIMIT = { label: "POST /api/chat/reactions", audience: "", duration: 10, maxRequests: 30 };

migrate(
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new JSONField({ name: "reactions" }));
    messages.createRule = `${messages.createRule} && ${NO_REACTIONS}`;
    messages.updateRule = `${messages.updateRule} && ${NO_REACTIONS}`;
    app.save(messages);

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== REACT_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (REACT_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("reactions");
    messages.createRule = (messages.createRule ?? "").replace(` && ${NO_REACTIONS}`, "");
    messages.updateRule = (messages.updateRule ?? "").replace(` && ${NO_REACTIONS}`, "");
    app.save(messages);

    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== REACT_LIMIT.label);
    app.save(settings);
  },
);
