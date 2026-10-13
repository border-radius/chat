import { describe, expect, it } from "vitest";
import { attachmentName, checkFiles, displayName, formatBytes, isImage, isVideo } from "../../../web/src/lib/files.ts";

const f = (name: string, bytes = 1) => new File([new Uint8Array(bytes)], name);

describe("attachment helpers (§17.4, §17.5)", () => {
  it("displayName strips PocketBase's random suffix", () => {
    expect(displayName("report_k3j2h1g0f9.pdf")).toBe("report.pdf");
    expect(displayName("my_holiday_photo_abcdefghij.jpeg")).toBe("my_holiday_photo.jpeg");
    expect(displayName("README_0123456789")).toBe("README");
    expect(displayName("plain.txt")).toBe("plain.txt");
    expect(displayName("short_abc.txt")).toBe("short_abc.txt");
  });

  it("BUG-28: attachmentName prefers the original name the server recorded", () => {
    const stored = "quarterly_report_final_k3j2h1g0f9.pdf";
    expect(attachmentName({ file_names: { [stored]: "Quarterly Report (final).pdf" } }, stored)).toBe("Quarterly Report (final).pdf");
    expect(attachmentName({}, stored)).toBe("quarterly_report_final.pdf");
    expect(attachmentName({ file_names: { other: "x" } }, stored)).toBe("quarterly_report_final.pdf");
  });

  it("isImage goes by extension", () => {
    for (const n of ["a.jpg", "a.JPEG", "a.png", "a.gif", "a.webp", "a.avif"]) expect(isImage(n), n).toBe(true);
    for (const n of ["a.svg", "a.pdf", "a.html", "png", "a.png.exe"]) expect(isImage(n), n).toBe(false);
  });

  it("isVideo goes by extension", () => {
    for (const n of ["a.mp4", "a.MP4", "a.m4v", "a.webm", "a.mov", "a.ogv"]) expect(isVideo(n), n).toBe(true);
    for (const n of ["a.avi", "a.mkv", "a.png", "mp4", "a.mp4.exe"]) expect(isVideo(n), n).toBe(false);
  });

  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("checkFiles allows 4 files per message, each up to 8 MB, and says why it refuses", () => {
    const three = [f("1"), f("2"), f("3")];
    const big = f("big.bin", 8 * 1024 * 1024 + 1);
    const res = checkFiles(three, [f("4"), big, f("5")]);
    expect(res.accepted.map((x) => x.name)).toEqual(["4"]);
    expect(res.rejected).toEqual([
      { name: "big.bin", reason: "larger than 8 MB" },
      { name: "5", reason: "at most 4 files per message" },
    ]);
  });
});
