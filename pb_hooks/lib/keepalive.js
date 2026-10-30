/// <reference path="../../types/pocketbase.d.ts" />
// PocketBase closes a realtime connection that has sent nothing for 5 minutes, and the clients take every reconnect for
// one that may have missed events: they load their rooms, unread counts, collections and open room again
// (docs/PERF.md §2.4). An event every 3 minutes keeps quiet connections open. No client listens for it, so it is
// dropped on arrival (old apps too).

const NAME = "chat/keepalive";

/**
 * Send the keepalive to every connected client.
 * @param {core.App} app
 */
function run(app) {
  const message = new SubscriptionMessage({ name: NAME, data: "{}" });
  const clients = app.subscriptionsBroker().clients();
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    if (client && !client.isDiscarded()) client.send(message);
  }
}

/**
 * POST /api/keepalive/tick (superusers): a run now, for tests.
 * @param {core.RequestEvent} e
 */
function tick(e) {
  run(e.app);
  return e.noContent(204);
}

module.exports = { run, tick };
