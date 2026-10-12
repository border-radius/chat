// Production build: web/ → pb_public/ (hashed assets + index.html), then enforce the size budget.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import {
  BASE_OPTIONS,
  checkBudget,
  ENTRIES,
  entryOutputs,
  formatSizes,
  injectAssets,
  OUTDIR,
  outputOf,
  staticImports,
  VIEWER,
  viewerDefine,
} from "./lib/build-utils.mjs";

await rm(OUTDIR, { recursive: true, force: true });
await mkdir(OUTDIR, { recursive: true });

/** @satisfies {import("esbuild").BuildOptions} */
const shared = {
  minify: true,
  sourcemap: "linked",
  entryNames: "assets/[name]-[hash]",
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
};

// The viewer's stylesheet first: the app's build needs its hashed name.
const viewerCss = await esbuild.build({
  ...shared,
  entryPoints: [{ in: VIEWER.css, out: "viewer" }],
  bundle: true,
  outdir: OUTDIR,
});
const viewerCssPath = outputOf(viewerCss.metafile, OUTDIR, VIEWER.css);

const result = await esbuild.build({ ...BASE_OPTIONS, ...shared, define: viewerDefine(viewerCssPath) });

const assets = entryOutputs(result.metafile, OUTDIR, ENTRIES);
const eager = staticImports(result.metafile, OUTDIR, assets.js);
if (eager.length) {
  console.error(`${assets.js} imports shared chunks (${eager.join(", ")}): lazy modules must not import its modules (DESIGN.md §17.7)`);
  process.exit(1);
}
const html = injectAssets(await readFile("web/index.html", "utf8"), assets);
await writeFile(`${OUTDIR}/index.html`, html);

const gz = async (/** @type {string} */ path) => gzipSync(await readFile(path), { level: 9 }).length;
const sizes = {
  js: await gz(`${OUTDIR}/${assets.js}`),
  css: await gz(`${OUTDIR}/${assets.css}`),
  html: gzipSync(html, { level: 9 }).length,
  viewerJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, VIEWER.js)}`),
  viewerCss: await gz(`${OUTDIR}/${viewerCssPath}`),
};

console.log(`built ${OUTDIR}/ (gzipped):\n${formatSizes(sizes)}`);
const over = checkBudget(sizes);
if (over.length) {
  console.error(`\nsize budget exceeded: ${over.join(", ")} (DESIGN.md §7.7)`);
  process.exit(1);
}
