import { afterEach, describe, expect, it, vi } from "vitest";
import { dayLabel, formatFull, formatTime, parsePb, sameDay, toPb } from "../../../web/src/lib/time.ts";

// TZ=UTC for the unit project (vitest.config.ts).
const NOW = parsePb("2026-10-10 15:30:00.000Z");
const L = "en-US";

describe("parsePb / toPb", () => {
  it("parses PocketBase datetimes (space separator)", () => {
    expect(parsePb("2026-10-10 15:30:00.123Z")).toBe(Date.UTC(2026, 9, 10, 15, 30, 0, 123));
  });

  it("returns NaN for empty values", () => {
    expect(parsePb("")).toBeNaN();
  });

  it("round-trips", () => {
    expect(toPb(Date.UTC(2026, 0, 2, 3, 4, 5, 6))).toBe("2026-01-02 03:04:05.006Z");
    expect(parsePb(toPb(NOW))).toBe(NOW);
  });

  it("sorts as strings in time order (fixed width)", () => {
    const a = toPb(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    const b = toPb(Date.UTC(2026, 0, 2, 3, 4, 5, 60));
    expect(a < b).toBe(true);
  });
});

describe("sameDay", () => {
  it("compares calendar days in the local zone", () => {
    expect(sameDay(parsePb("2026-10-10 00:00:00.000Z"), parsePb("2026-10-10 23:59:59.999Z"))).toBe(true);
    expect(sameDay(parsePb("2026-10-09 23:59:59.999Z"), parsePb("2026-10-10 00:00:00.000Z"))).toBe(false);
  });
});

describe("formatTime", () => {
  it("shows only the time for today", () => {
    expect(formatTime(parsePb("2026-10-10 09:05:00.000Z"), NOW, L)).toBe("9:05 AM");
  });

  it("shows date and time for other days this year", () => {
    expect(formatTime(parsePb("2026-10-09 21:00:00.000Z"), NOW, L)).toBe("Oct 9, 9:00 PM");
  });

  it("includes the year for other years", () => {
    expect(formatTime(parsePb("2025-12-31 08:00:00.000Z"), NOW, L)).toBe("Dec 31, 2025, 8:00 AM");
  });
});

describe("dayLabel (date dividers)", () => {
  it("labels today and yesterday", () => {
    expect(dayLabel(parsePb("2026-10-10 01:00:00.000Z"), NOW, L)).toBe("Today");
    expect(dayLabel(parsePb("2026-10-09 23:00:00.000Z"), NOW, L)).toBe("Yesterday");
  });

  it("uses weekday + date for older days this year, adding the year otherwise", () => {
    expect(dayLabel(parsePb("2026-10-01 12:00:00.000Z"), NOW, L)).toBe("Thursday, October 1");
    expect(dayLabel(parsePb("2025-10-01 12:00:00.000Z"), NOW, L)).toBe("Wednesday, October 1, 2025");
  });
});

describe("formatFull (tooltips)", () => {
  it("shows the full date and time", () => {
    expect(formatFull(parsePb("2026-10-09 21:00:05.000Z"), L)).toBe("Oct 9, 2026, 9:00:05 PM");
  });
});

describe("formatter caching (§7.7)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates each Intl.DateTimeFormat once, not per call", async () => {
    vi.resetModules();
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    const fresh = await import("../../../web/src/lib/time.ts");
    for (let i = 0; i < 50; i++) {
      fresh.formatTime(NOW - i * 3_600_000, NOW, L);
      fresh.dayLabel(NOW - i * 86_400_000, NOW, L);
      fresh.formatFull(NOW, L);
    }
    // time, short date+time, date+time+year, weekday, weekday+year, full
    expect(spy.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
