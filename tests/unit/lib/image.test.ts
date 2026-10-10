import { afterEach, describe, expect, it, vi } from "vitest";
import { fitWithin, prepareImage } from "../../../web/src/lib/image.ts";

describe("fitWithin (§15.3)", () => {
  it("scales the longest edge down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 512)).toEqual({ width: 384, height: 512 });
    expect(fitWithin(1000, 1000, 512)).toEqual({ width: 512, height: 512 });
  });

  it("never scales up", () => {
    expect(fitWithin(300, 200, 2048)).toEqual({ width: 300, height: 200 });
  });

  it("never returns a zero edge", () => {
    expect(fitWithin(10_000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

describe("prepareImage (§15.3)", () => {
  const drawn: { width: number; height: number }[] = [];
  let encodable = new Set(["image/webp", "image/jpeg"]);

  function stubBrowser(size = { width: 4000, height: 3000 }, decode: "ok" | "fail" = "ok") {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        if (decode === "fail") throw new Error("bad image");
        return { ...size, close };
      }),
    );
    class FakeCanvas {
      getContext() {
        return { drawImage: (_b: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ width, height }) };
      }
      async convertToBlob({ type }: { type: string }) {
        return new Blob(["x"], { type: encodable.has(type) ? type : "image/png" });
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    return { close };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    drawn.length = 0;
    encodable = new Set(["image/webp", "image/jpeg"]);
  });

  const file = (name: string, type: string) => new File(["original"], name, { type });

  it("re-encodes JPEG as WebP at most maxEdge px, and frees the bitmap", async () => {
    const { close } = stubBrowser();
    const out = await prepareImage(file("photo.jpeg", "image/jpeg"), 2048);
    expect(out.type).toBe("image/webp");
    expect(out.name).toBe("photo.webp");
    expect(drawn).toEqual([{ width: 2048, height: 1536 }]);
    expect(close).toHaveBeenCalled();
  });

  it("falls back to JPEG where WebP can't be encoded", async () => {
    stubBrowser();
    encodable = new Set(["image/jpeg"]);
    const out = await prepareImage(file("shot.png", "image/png"), 512);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("shot.jpg");
  });

  it("uploads GIFs and non-images unchanged", async () => {
    stubBrowser();
    const gif = file("anim.gif", "image/gif");
    const pdf = file("doc.pdf", "application/pdf");
    expect(await prepareImage(gif, 512)).toBe(gif);
    expect(await prepareImage(pdf, 512)).toBe(pdf);
    expect(drawn).toEqual([]);
  });

  it("returns the original when decoding fails", async () => {
    stubBrowser(undefined, "fail");
    const f = file("broken.jpg", "image/jpeg");
    expect(await prepareImage(f, 512)).toBe(f);
  });

  it("returns the original when nothing usable can be encoded", async () => {
    stubBrowser();
    encodable = new Set();
    const f = file("x.webp", "image/webp");
    expect(await prepareImage(f, 512)).toBe(f);
  });
});
