// Spawns a throwaway PocketBase process on a free port with its own temp data dir.
// Shared by the Vitest integration globalSetup and the Playwright webServer.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "../..");
const bin = join(root, "bin/pocketbase");

export const SUPERUSER = { email: "admin@test.local", password: "test-password-123" } as const;

export interface PocketBaseServer {
  url: string;
  dataDir: string;
  publicDir: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Directory served as static files. Defaults to an empty dir inside the temp data dir. */
  publicDir?: string;
  port?: number;
  /** Reuse an existing data dir (kept on stop). Defaults to a fresh temp dir (removed on stop). */
  dataDir?: string;
  /** Pipe PocketBase stdout/stderr to this process (useful when debugging). */
  verbose?: boolean;
}

export async function startPocketBase(opts: StartOptions = {}): Promise<PocketBaseServer> {
  const tmp = await mkdtemp(join(tmpdir(), "chat-pb-"));
  const dataDir = opts.dataDir ?? join(tmp, "pb_data");
  const publicDir = opts.publicDir ?? join(tmp, "pb_public");
  const dirArgs = [
    `--dir=${dataDir}`,
    `--migrationsDir=${join(root, "pb_migrations")}`,
    `--hooksDir=${join(root, "pb_hooks")}`,
    // Never let tests write generated migrations into the repo.
    "--automigrate=false",
  ];

  await promisify(execFile)(bin, ["superuser", "upsert", SUPERUSER.email, SUPERUSER.password, ...dirArgs]);

  const port = opts.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(
    bin,
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      `--publicDir=${publicDir}`,
      "--hooksWatch=false",
      ...dirArgs,
    ],
    { stdio: opts.verbose ? "inherit" : "pipe" },
  );

  let output = "";
  proc.stdout?.on("data", (d: Buffer) => (output += d));
  proc.stderr?.on("data", (d: Buffer) => (output += d));

  const stop = async () => {
    await kill(proc);
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    await waitForHealth(url, proc);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- pocketbase output ---\n${output}`);
  }

  return { url, dataDir, publicDir, stop };
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`pocketbase exited with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pocketbase did not become healthy within ${timeoutMs}ms`);
}

function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const force = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(force);
      ok();
    });
    proc.kill("SIGTERM");
  });
}

export interface RateLimits {
  enabled: boolean;
  rules: { label: string; audience: string; duration: number; maxRequests: number }[];
}

/**
 * Turn off PocketBase's per-IP rate limits: every test client connects from 127.0.0.1, so limits meant for
 * real users would trip across unrelated tests. Returns the settings as the migrations left them.
 */
export async function disableRateLimits(url: string): Promise<RateLimits> {
  const { default: PocketBase } = await import("pocketbase");
  const admin = new PocketBase(url);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  const { rateLimits } = (await admin.settings.getAll()) as { rateLimits: RateLimits };
  await admin.settings.update({ rateLimits: { ...rateLimits, enabled: false } });
  return rateLimits;
}
