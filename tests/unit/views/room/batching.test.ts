// Room view: changes that arrive within one frame are drawn together (mergeChanges).

import { describe, expect, it } from "vitest";
import { mergeChanges } from "../../../../web/src/views/room.ts";

describe("mergeChanges", () => {
  it("renders if either change did, keeping the anchor if either asked for it", () => {
    expect(mergeChanges({}, {})).toEqual({});
    expect(mergeChanges({ render: {} }, {})).toEqual({ render: {} });
    expect(mergeChanges({}, { render: {} })).toEqual({ render: {} });
    expect(mergeChanges({ render: { anchor: true } }, { render: {} })).toEqual({ render: { anchor: true } });
    expect(mergeChanges({ render: {} }, { render: { anchor: true } })).toEqual({ render: { anchor: true } });
  });

  it("the later scroll and notice win; an earlier one stays when the later change has none", () => {
    expect(mergeChanges({ render: {}, scroll: "bottom" }, { render: { anchor: true } })).toEqual({
      render: { anchor: true },
      scroll: "bottom",
    });
    expect(mergeChanges({ scroll: "top" }, { scroll: "bottom" })).toEqual({ scroll: "bottom" });
    expect(mergeChanges({ notice: "a" }, { notice: "" })).toEqual({ notice: "" });
    expect(mergeChanges({ notice: "a" }, {})).toEqual({ notice: "a" });
  });
});
