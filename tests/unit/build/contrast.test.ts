import { describe, expect, it } from "vitest";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const { resolve } = process.getBuiltinModule("node:path") as typeof import("node:path");

const css = readFileSync(resolve(import.meta.dirname, "../../../web/styles/app.css"), "utf8");

/** The color tokens of the first block of `css` that declares `--bg` after `from` (light: `:root`, dark: its media query). */
function tokens(from: number): Record<string, string> {
  const start = css.indexOf("--bg:", from);
  const block = css.slice(start, css.indexOf("}", start));
  const full = (hex: string) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex).toLowerCase();
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)].map((m) => [m[1]!, full(m[2]!)]));
}

/** WCAG 2.1 contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("theme colors (WCAG 2.1 AA, 4.5:1 for text)", () => {
  const themes = { light: tokens(0), dark: tokens(css.indexOf("prefers-color-scheme: dark")) };

  for (const [theme, t] of Object.entries(themes)) {
    it(`${theme}: red text (Delete, errors) is readable on every background, hovered buttons included (QA BUG-57)`, () => {
      for (const bg of ["bg", "surface", "raised", "hover", "highlight"]) {
        expect(contrast(t.danger!, t[bg]!), `--danger on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
