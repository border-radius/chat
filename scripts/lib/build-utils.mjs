// Pure helpers for scripts/build.mjs. Kept side-effect free so they can be unit-tested.

/** @typedef {{ js: number, css: number, html: number }} Sizes gzipped byte sizes */

/** Where builds go: PocketBase serves this directory. */
export const OUTDIR = "pb_public";

/** Source entry points; both are bundled to assets/app.* (hashed in production). */
export const ENTRIES = Object.freeze({ js: "web/src/main.ts", css: "web/styles/app.css" });

/**
 * esbuild options shared by `build` and `dev`; each adds its own minify/sourcemap/naming.
 * @satisfies {import("esbuild").BuildOptions}
 */
export const BASE_OPTIONS = {
  entryPoints: [
    { in: ENTRIES.js, out: "app" },
    { in: ENTRIES.css, out: "app" },
  ],
  bundle: true,
  format: /** @type {const} */ ("esm"),
  target: "es2022",
  outdir: OUTDIR,
};

/** Gzipped size budget in bytes (DESIGN.md §7.7). */
export const BUDGET = Object.freeze({ js: 30 * 1024, css: 5 * 1024, html: 1536 });

/**
 * @param {Sizes} sizes
 * @returns {(keyof Sizes)[]} names of assets over budget
 */
export function checkBudget(sizes) {
  return /** @type {(keyof Sizes)[]} */ (Object.keys(BUDGET)).filter((k) => sizes[k] > BUDGET[k]);
}

/** @param {Sizes} sizes */
export function formatSizes(sizes) {
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(2)} KB`;
  const over = new Set(checkBudget(sizes));
  return /** @type {(keyof Sizes)[]} */ (Object.keys(BUDGET))
    .map((k) => `${k.padEnd(4)}${kb(sizes[k]).padStart(9)} / ${kb(BUDGET[k])}${over.has(k) ? "  OVER" : ""}`)
    .join("\n");
}

/**
 * Replace the `<!--CSS-->` and `<!--JS-->` placeholders in the HTML template.
 * @param {string} template
 * @param {{ js: string, css: string }} assets paths relative to the public dir
 */
export function injectAssets(template, assets) {
  for (const p of ["<!--CSS-->", "<!--JS-->"]) {
    if (!template.includes(p)) throw new Error(`index.html template is missing the ${p} placeholder`);
  }
  return template
    .replace("<!--CSS-->", `<link rel="stylesheet" href="/${assets.css}">`)
    .replace("<!--JS-->", `<script type="module" src="/${assets.js}"></script>`);
}

/**
 * Find the output files esbuild produced for the given entry points.
 * @param {{ outputs: Record<string, { entryPoint?: string }> }} metafile
 * @param {string} outdir
 * @param {{ js: string, css: string }} entries
 * @returns {{ js: string, css: string }} paths relative to outdir
 */
export function entryOutputs(metafile, outdir, entries) {
  const prefix = `${outdir.replace(/\/$/, "")}/`;
  const find = (/** @type {string} */ entry) => {
    const out = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint === entry)?.[0];
    if (!out) throw new Error(`no esbuild output for entry ${entry}`);
    return out.startsWith(prefix) ? out.slice(prefix.length) : out;
  };
  return { js: find(entries.js), css: find(entries.css) };
}
