import { describe, expect, it } from "vitest";
import { entryOutputs, injectAssets } from "../../../scripts/lib/build-utils.mjs";

const template = `<!doctype html><head><!--CSS--></head><body><div id="app"></div><!--JS--></body>`;

describe("injectAssets", () => {
  it("replaces placeholders with absolute hashed asset paths", () => {
    const html = injectAssets(template, { js: "assets/app-AB12.js", css: "assets/app-CD34.css" });
    expect(html).toContain(`<link rel="stylesheet" href="/assets/app-CD34.css">`);
    expect(html).toContain(`<script type="module" src="/assets/app-AB12.js"></script>`);
    expect(html).not.toContain("<!--");
  });

  it("puts the stylesheet in head and the script where the placeholder was", () => {
    const html = injectAssets(template, { js: "assets/a.js", css: "assets/a.css" });
    expect(html.indexOf("a.css")).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf("a.js")).toBeGreaterThan(html.indexOf(`<div id="app">`));
  });

  it("throws when a placeholder is missing", () => {
    expect(() => injectAssets("<head><!--CSS--></head>", { js: "a.js", css: "a.css" })).toThrow(/<!--JS-->/);
    expect(() => injectAssets("<body><!--JS--></body>", { js: "a.js", css: "a.css" })).toThrow(/<!--CSS-->/);
  });
});

describe("entryOutputs", () => {
  const metafile = {
    inputs: {},
    outputs: {
      "pb_public/assets/app-AB12.js": { entryPoint: "web/src/main.ts" },
      "pb_public/assets/app-AB12.js.map": {},
      "pb_public/assets/chunk-XY.js": {},
      "pb_public/assets/app-CD34.css": { entryPoint: "web/styles/app.css" },
    },
  };

  it("finds the js and css entry outputs relative to outdir", () => {
    expect(entryOutputs(metafile, "pb_public", { js: "web/src/main.ts", css: "web/styles/app.css" })).toEqual({
      js: "assets/app-AB12.js",
      css: "assets/app-CD34.css",
    });
  });

  it("throws when an entry has no output", () => {
    expect(() => entryOutputs(metafile, "pb_public", { js: "web/src/other.ts", css: "web/styles/app.css" })).toThrow(/web\/src\/other\.ts/);
  });
});
