// The workers' shared lock (pb_hooks/lib/worker.js, docs/REFACTOR.md round 4): one run at a time, a stale lock taken
// over, and the run that lost it neither renews nor drops the new run's lock (QA BUG-147).

import { describe, expect, it } from "vitest";
import { adminClient } from "./helpers.ts";

type Step = { op: "lock" | "beat" | "unlock" | "get"; run: string } | { op: "sleep"; ms: number };

let n = 0;
async function steps(staleMs: number, list: Step[]): Promise<unknown[]> {
  const pb = await adminClient();
  return pb.send("/api/test/worker-lock", { method: "POST", body: { name: `test.lock.${++n}`, staleMs, steps: list } });
}

describe("worker lock", () => {
  it("is held by one run at a time, and free once unlocked", async () => {
    const out = await steps(60_000, [
      { op: "lock", run: "a" },
      { op: "lock", run: "b" },
      { op: "beat", run: "a" },
      { op: "unlock", run: "a" },
      { op: "lock", run: "b" },
      { op: "get", run: "b" },
    ]);
    expect(out).toEqual([true, false, true, null, true, true]);
  });

  it("a stale lock is taken over: the old run can't renew it, and its unlock leaves the new run's alone", async () => {
    const out = await steps(50, [
      { op: "lock", run: "a" },
      { op: "sleep", ms: 100 },
      { op: "lock", run: "b" },
      { op: "beat", run: "a" },
      { op: "unlock", run: "a" },
      { op: "get", run: "b" },
      { op: "beat", run: "b" },
    ]);
    expect(out).toEqual([true, null, true, false, null, true, true]);
  });
});
