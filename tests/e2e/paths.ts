// Shared between the e2e webServer (server.ts) and the specs (fixtures.ts).
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 8091);
export const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATA_DIR = join(tmpdir(), `chat-e2e-${E2E_PORT}`);
