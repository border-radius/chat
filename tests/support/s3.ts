// A throwaway S3 server for tests that keep PocketBase's files in S3: versitygw (https://github.com/versity/versitygw)
// serving a temp folder, each top-level folder a bucket. VERSITYGW names the binary, else `versitygw` on the PATH.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.env.VERSITYGW || "versitygw";

/** Is there a versitygw to run? */
export function hasS3Server(): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface S3Server {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secret: string;
  /** The bucket's folder: an object "a/b" is the file `${dir}/a/b`. */
  dir: string;
  stop(): Promise<void>;
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });

export async function startS3(): Promise<S3Server> {
  const root = mkdtempSync(join(tmpdir(), "chat-s3-"));
  const bucket = "chat";
  const dir = join(root, bucket);
  mkdirSync(dir);
  const port = await freePort();
  const accessKey = "test-access";
  const secret = "test-secret-key";
  const proc: ChildProcess = spawn(bin, ["--port", `127.0.0.1:${port}`, "--access", accessKey, "--secret", secret, "posix", root], {
    stdio: "pipe",
  });
  let output = "";
  proc.stdout?.on("data", (d: Buffer) => (output += d));
  proc.stderr?.on("data", (d: Buffer) => (output += d));
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode === null) {
      await new Promise((ok) => {
        proc.once("exit", ok);
        proc.kill("SIGTERM");
      });
    }
    rmSync(root, { recursive: true, force: true });
  };
  // Up once it answers anything (403 without credentials).
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fetch(endpoint);
      break;
    } catch {
      if (proc.exitCode !== null || Date.now() > deadline) {
        await stop();
        throw new Error(`versitygw didn't start\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { endpoint, bucket, accessKey, secret, dir, stop };
}
