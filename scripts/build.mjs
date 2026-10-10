// Production build: web/ → pb_public/ (hashed assets + index.html), then enforce the size budget.
import * as esbuild from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { BASE_OPTIONS, ENTRIES, OUTDIR, checkBudget, entryOutputs, formatSizes, injectAssets } from "./lib/build-utils.mjs";

await rm(OUTDIR, { recursive: true, force: true });
await mkdir(OUTDIR, { recursive: true });

const result = await esbuild.build({
  ...BASE_OPTIONS,
  minify: true,
  sourcemap: "linked",
  entryNames: "assets/[name]-[hash]",
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
});

const assets = entryOutputs(result.metafile, OUTDIR, ENTRIES);
const html = injectAssets(await readFile("web/index.html", "utf8"), assets);
await writeFile(`${OUTDIR}/index.html`, html);

const gz = async (/** @type {string} */ path) => gzipSync(await readFile(path), { level: 9 }).length;
const sizes = {
  js: await gz(`${OUTDIR}/${assets.js}`),
  css: await gz(`${OUTDIR}/${assets.css}`),
  html: gzipSync(html, { level: 9 }).length,
};

console.log(`built ${OUTDIR}/ (gzipped):\n${formatSizes(sizes)}`);
const over = checkBudget(sizes);
if (over.length) {
  console.error(`\nsize budget exceeded: ${over.join(", ")} (DESIGN.md §7.7)`);
  process.exit(1);
}
