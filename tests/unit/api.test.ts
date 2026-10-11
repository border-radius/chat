import { describe, expect, it } from "vitest";
import { listOptions, MSG_FIELDS } from "../../web/src/api.ts";
import { latest } from "../../web/src/lib/cursor.ts";
import { createClient } from "../../web/src/pb.ts";

describe("listOptions", () => {
  const pb = createClient("http://localhost");

  it("binds params via the given filter function and requests a lean, totals-free page", () => {
    const opts = listOptions(latest("r1"), pb.filter);
    expect(opts).toEqual({
      filter: `room = "r1"`,
      sort: "-created,-id",
      skipTotal: true,
      expand: "author,reply_to.author,forwarded_from",
      fields: MSG_FIELDS,
    });
  });

  it("escapes hostile values through pb.filter", () => {
    const opts = listOptions(latest(`x" || id != "`), pb.filter);
    expect(opts.filter).toBe(`room = "x\\" || id != \\""`);
  });

  it("fetches only the fields the UI renders, never email", () => {
    expect(MSG_FIELDS.split(",")).toEqual([
      "id",
      "room",
      "text",
      "created",
      "updated",
      "edited_at",
      "deleted",
      "files",
      "file_names",
      "reactions",
      "author",
      "expand.author.id",
      "expand.author.name",
      "expand.author.avatar",
      // the message a reply quotes (§19)
      "reply_to",
      "expand.reply_to.id",
      "expand.reply_to.author",
      "expand.reply_to.text",
      "expand.reply_to.deleted",
      "expand.reply_to.files",
      "expand.reply_to.expand.author.id",
      "expand.reply_to.expand.author.name",
      // who first wrote a forwarded message (§21.3)
      "forwarded_from",
      "expand.forwarded_from.id",
      "expand.forwarded_from.name",
    ]);
    expect(MSG_FIELDS).not.toContain("email");
  });
});
