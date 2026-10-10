// Close realtime connections opened by tests/support/api.ts clients after every unit test, so happy-dom's
// window teardown doesn't have to abort open SSE requests (noisy AbortErrors, possible unhandled rejections).
import { afterEach } from "vitest";
import { closeClients } from "./api.ts";

afterEach(async () => {
  await closeClients();
});
