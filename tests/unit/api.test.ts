import { describe, expect, it, vi } from "vitest";
import { createApi, listOptions, MSG_FIELDS } from "../../web/src/api.ts";
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
      "file_sources",
      "file_dims",
      "reactions",
      "previews",
      "author",
      "expand.author.id",
      "expand.author.name",
      "expand.author.avatar",
      "expand.author.no_dms",
      // which instance a stand-in is on (§33.4)
      "expand.author.instance",
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
      "forward_of",
      "expand.forwarded_from.id",
      "expand.forwarded_from.name",
    ]);
    expect(MSG_FIELDS).not.toContain("email");
  });
});

describe("onConnect", () => {
  it("a first connect that fails is no unhandled rejection: the page started offline (QA BUG-85)", async () => {
    /** An EventSource that fails at once, as with no network. */
    class Offline {
      onerror: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onerror?.());
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", Offline);
    try {
      const api = createApi(createClient("http://offline.test"));
      const off = api.onConnect(() => {});
      await new Promise((r) => setTimeout(r, 10)); // an unhandled rejection would fail the run here
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
