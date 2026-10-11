import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalFile } from "../../../web/src/lib/types.ts";
import { type Composer, createComposer, editProblem } from "../../../web/src/views/room/composer.ts";
import { pngFile } from "../../support/files.ts";

describe("composer attachments (§17.4)", () => {
  let ac: AbortController;
  let composer: Composer;
  let sent: [string, LocalFile[]][];
  let revoked: string[];

  beforeEach(() => {
    let n = 0;
    revoked = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:local-${++n}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    ac = new AbortController();
    sent = [];
    composer = createComposer({
      id: "c",
      onSend: (text, files) => {
        sent.push([text, files]);
        return true;
      },
      onEditLast: () => false,
      onCancelReply: () => {},
      onEmoji: () => {},
      signal: ac.signal,
    });
    document.body.append(composer.el);
  });
  afterEach(() => {
    ac.abort();
    composer.el.remove();
    vi.restoreAllMocks();
  });

  const textarea = () => composer.el.querySelector("textarea")!;
  const sendButton = () => composer.el.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const items = () => [...composer.el.querySelectorAll<HTMLElement>(".tray-item")];
  const trayError = () => composer.el.querySelector(".tray-error")!.textContent;
  const enter = () => textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const pdf = (name = "doc.pdf", bytes = 10) => new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

  it("the Attach button opens the file picker; picked files show in the tray (images previewed)", async () => {
    const input = composer.el.querySelector<HTMLInputElement>("input[type=file]")!;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    composer.el.querySelector<HTMLButtonElement>("button.attach")!.click();
    expect(click).toHaveBeenCalled();
    Object.defineProperty(input, "files", { configurable: true, value: [pngFile("a.png"), pdf()] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(items()[0]!.querySelector("img")!.getAttribute("src")).toBe("blob:local-1");
    expect(items()[1]!.querySelector("img")).toBeNull();
    expect(items()[1]!.textContent).toContain("doc.pdf");
  });

  it("pasted files are added", async () => {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [pngFile("shot.png")] } });
    textarea().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(items()).toHaveLength(1));
  });

  it("Send works with files and no text; Enter sends both; the tray clears and the URLs pass to the message", async () => {
    expect(sendButton().disabled).toBe(true);
    await composer.addFiles([pngFile("a.png")]);
    expect(sendButton().disabled).toBe(false);
    enter();
    expect(sent).toEqual([["", [{ file: expect.any(File), url: "blob:local-1" }]]]);
    expect(items()).toHaveLength(0);
    expect(revoked).toEqual([]); // the sent message owns them now
    await composer.addFiles([pdf()]);
    textarea().value = "  with text ";
    textarea().dispatchEvent(new Event("input"));
    enter();
    expect(sent[1]![0]).toBe("with text");
  });

  it("× removes a file and revokes its preview", async () => {
    await composer.addFiles([pngFile("a.png"), pdf()]);
    items()[0]!.querySelector<HTMLButtonElement>("button.remove")!.click();
    expect(items().map((i) => i.querySelector(".tray-name")!.textContent)).toEqual(["doc.pdf"]);
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("refuses files over the limits and says why", async () => {
    await composer.addFiles([pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf")]);
    await composer.addFiles([pdf("big.pdf", 8 * 1024 * 1024 + 1), pdf("4.pdf"), pdf("5.pdf")]);
    expect(items()).toHaveLength(4);
    expect(trayError()).toContain("“big.pdf”: larger than 8 MB.");
    expect(trayError()).toContain("“5.pdf”: at most 4 files per message.");
  });

  it("over-long text can't be sent even with files", async () => {
    await composer.addFiles([pdf()]);
    textarea().value = "x".repeat(2001);
    textarea().dispatchEvent(new Event("input"));
    expect(sendButton().disabled).toBe(true);
  });

  it("unsent files' previews are revoked when the composer goes away", async () => {
    await composer.addFiles([pngFile("a.png")]);
    ac.abort();
    expect(revoked).toEqual(["blob:local-1"]);
  });

  it("an edit may empty the text of a message with attachments", () => {
    expect(editProblem("  ")).toMatch(/can't be empty/);
    expect(editProblem("  ", true)).toBe("");
  });

  it("QA BUG-42: text made only of zero-width characters is empty (the server would refuse it)", () => {
    textarea().value = "\u200b\u2060 \ufeff";
    textarea().dispatchEvent(new Event("input"));
    expect(sendButton().disabled).toBe(true);
    enter();
    expect(sent).toEqual([]);
    expect(editProblem("\u200b")).toMatch(/can't be empty/);
    // Joiners inside real text are text.
    textarea().value = "👨\u200d👩";
    textarea().dispatchEvent(new Event("input"));
    expect(sendButton().disabled).toBe(false);
  });
});
