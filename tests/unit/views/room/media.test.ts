// Media grid (§30): its query, and the grid in the room view: newest first, under month headings, a page at a time.

import { describe, expect, it, vi } from "vitest";
import { latest, older, withFiles } from "../../../../web/src/lib/cursor.ts";
import type { Message } from "../../../../web/src/lib/types.ts";
import { mediaQuery } from "../../../../web/src/views/room/media.ts";
import { intercept, seedMessages } from "../../../support/api.ts";
import { io, me, mount, newRoom, root, useRoomView } from "./harness.ts";

describe("mediaQuery", () => {
  it("is withFiles(latest) and withFiles(older): the chunk can't import lib/cursor.ts", () => {
    expect(mediaQuery("r1")).toEqual(withFiles(latest("r1")));
    const m = { id: "abc", created: "2026-10-18 10:00:00.000Z" } as Message;
    expect(mediaQuery("r1", m)).toEqual(withFiles(older("r1", m)));
  });
});

describe("room view: media grid (§30)", () => {
  useRoomView();

  const DAY = 86_400_000;
  const toggle = () => root.querySelector<HTMLButtonElement>("header.room-header button[aria-label='Media']")!;
  const grid = () => document.querySelector<HTMLDialogElement>("dialog.media");
  const tiles = () => [...grid()!.querySelectorAll<HTMLButtonElement>("button.media-tile")];
  const status = () => grid()!.querySelector(".media-status")!;
  const names = () => tiles().map((t) => t.getAttribute("aria-label")!.split(",")[0]);
  const open = async () => {
    toggle().click();
    await vi.waitFor(() => expect(grid()?.open).toBe(true));
    // A real observer reports the end of the (empty) grid as soon as it observes it; the fake one doesn't.
    expect(io.intersect(status())).toBe(true);
  };

  it("shows images and videos newest first under month headings, and fetches older ones at the end", async () => {
    const room = await newRoom();
    // 70 days from June 1, one message a day, each with an image but every 10th (a PDF); the newest has an image and a video.
    await seedMessages(room.id, me.user.id, 70, {
      startAt: Date.UTC(2026, 5, 1, 12),
      stepMs: DAY,
      files: (i) =>
        i === 69 ? ["a_abcdefghij.png", "b_abcdefghij.mp4"] : i % 10 === 9 ? ["notes_abcdefghij.pdf"] : [`p${i}_abcdefghij.png`],
    });
    await mount(room);
    await open();
    await vi.waitFor(() => expect(tiles()).toHaveLength(47)); // the newest 50 messages: 45 with an image, the newest with 2
    // A message's files in their own order once reversed for the viewer: newest first, last to first.
    expect(names().slice(0, 3)).toEqual(["b.mp4", "a.png", "p68.png"]);
    expect(tiles()[0]!.querySelector("video")!.getAttribute("src")).toMatch(/#t=0\.001$/);
    expect(tiles()[1]!.querySelector("img")!.getAttribute("src")).toMatch(/thumb=240x240/);
    expect(tiles()[0]!.getAttribute("aria-label")).toMatch(/^b\.mp4, video, Me, /);
    const months = () => [...grid()!.querySelectorAll("h3")].map((h) => h.textContent);
    expect(months()).toEqual(["August 2026", "July 2026", "June 2026"]);

    expect(io.intersect(status())).toBe(true);
    await vi.waitFor(() => expect(tiles()).toHaveLength(65));
    expect(names().at(-1)).toBe("p0.png");
    expect(months()).toEqual(["August 2026", "July 2026", "June 2026"]); // June goes on under its heading
    // All there: nothing more to fetch.
    expect(io.observing(status())).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("says when there are none, and offers Retry when a page fails", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 3);
    let fail = true;
    intercept(
      me.api,
      "page",
      (page) => (q, sig) => (fail && q.filter.includes("files:length") ? Promise.reject(new Error("offline")) : page(q, sig)),
    );
    await mount(room);
    await open();
    await vi.waitFor(() => expect(status().textContent).toBe("Couldn't load media. Retry"));
    fail = false;
    status().querySelector("button")!.click();
    await vi.waitFor(() => expect(status().textContent).toBe("No photos or videos here yet."));
  });

  it("Escape closes it and focus goes back to the button; one grid at a time", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 1, { files: () => ["x_abcdefghij.png"] });
    await mount(room);
    toggle().focus();
    await open();
    toggle().click();
    await vi.waitFor(() => expect(tiles()).toHaveLength(1));
    expect(document.querySelectorAll("dialog.media")).toHaveLength(1);
    grid()!.dispatchEvent(new Event("close"));
    expect(grid()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
