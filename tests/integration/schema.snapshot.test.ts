// The effective schema, as the migrations leave it: every collection's API rules, fields and indexes, and the rate
// limits, in docs/schema.snapshot.json. The rules are built up across many migrations (some append to what an earlier
// one set), so this is the one place to read them whole, and a change to any of them shows up as a diff in review.
// After an intended change: `npm run schema:snapshot`, and commit the new snapshot with the migration.

import type { CollectionModel } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import { adminClient } from "./helpers.ts";

const RULES = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule", "authRule", "manageRule"] as const;

/**
 * A rule as the list of its top-level `&&` conditions (outside parentheses and quotes), so a diff shows the condition
 * that changed rather than one long line. A rule with a single condition stays a string; null (superusers only) and
 * "" (anyone) stay as they are.
 */
function conditions(rule: string | null): string | string[] | null {
  if (!rule) return rule;
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && rule.startsWith(" && ", i)) {
      parts.push(rule.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(rule.slice(start));
  return parts.length === 1 ? rule : parts;
}

/** What a collection's behavior depends on. Ids (random per database) are left out; relations name their collection. */
function shape(c: CollectionModel, nameOf: Map<string, string>) {
  const rules = Object.fromEntries(
    RULES.filter((r) => r in c).map((r) => [r, conditions(((c as Record<string, unknown>)[r] as string | null) ?? null)]),
  );
  const fields = (c.fields as Record<string, unknown>[]).map(({ id: _id, collectionId, ...f }) =>
    collectionId === undefined ? f : { ...f, collection: nameOf.get(collectionId as string) ?? collectionId },
  );
  const auth =
    c.type === "auth"
      ? {
          passwordAuth: (c as Record<string, unknown>).passwordAuth,
          oauth2: { enabled: ((c as Record<string, unknown>).oauth2 as { enabled?: boolean } | undefined)?.enabled ?? false },
        }
      : {};
  return { name: c.name, type: c.type, ...rules, ...auth, fields, indexes: c.indexes };
}

describe("schema snapshot", () => {
  it("matches docs/schema.snapshot.json", async () => {
    const pb = await adminClient();
    const all = await pb.collections.getFullList();
    const nameOf = new Map(all.map((c) => [c.id, c.name]));
    // PocketBase's own collections (_superusers, _mfas, …) change with PocketBase, not with this app.
    const collections = all
      .filter((c) => !c.system)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => shape(c, nameOf));
    // As the migrations set them: the test harness turns rate limits off after boot.
    const { rules: rateLimits } = inject("bootRateLimits");
    const snapshot = { collections, rateLimits: [...rateLimits].sort((a, b) => a.label.localeCompare(b.label)) };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot("../../docs/schema.snapshot.json");
  });
});
