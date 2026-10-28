// Per-test setup for the component project (which runs against a real PocketBase).
import { afterEach, vi } from "vitest";
import { closeClients, stopContexts } from "./api.ts";

// vi.waitFor defaults to 1s; real requests (e.g. password hashing on signup) can take longer when every test
// file runs in parallel against one server. A slow server shouldn't fail a test, a wrong result should.
const waitFor = vi.waitFor;
vi.waitFor = ((cb: Parameters<typeof waitFor>[0], opts?: Parameters<typeof waitFor>[1]) =>
  waitFor(cb, typeof opts === "number" ? opts : { timeout: 5_000, ...opts })) as typeof vi.waitFor;

// Close realtime connections opened by tests/support/api.ts clients after every test, so happy-dom's window
// teardown doesn't have to abort open SSE requests (noisy AbortErrors, possible unhandled rejections).
afterEach(async () => {
  stopContexts();
  await closeClients();
});
