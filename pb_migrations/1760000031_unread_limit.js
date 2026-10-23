/// <reference path="../types/pocketbase.d.ts" />
// GET /api/chat/unread (DESIGN.md §18.1) counts every room the user can see, the heaviest read there is (237 ms with
// 1 000 rooms): held to what POST /api/chat/reads is, not just the /api/ limit (QA BUG-144). A client asks again at
// most every 250 ms, and only when something changed.

const UNREAD_LIMIT = { label: "GET /api/chat/unread", audience: "", duration: 60, maxRequests: 120 };

migrate(
  (app) => {
    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== UNREAD_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (UNREAD_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== UNREAD_LIMIT.label);
    app.save(settings);
  },
);
