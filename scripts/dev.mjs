// Dev loop: esbuild watch (unminified, unhashed) → pb_public/, plus `pocketbase serve --dev`.
// Ctrl-C stops both. Reload the browser manually after changes.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { injectAssets } from "./lib/build-utils.mjs";

const OUTDIR = "pb_public";
const PORT = process.env.PORT ?? "8090";

await mkdir(OUTDIR, { recursive: true });

/** @type {esbuild.Plugin} */
const writeIndex = {
  name: "write-index",
  setup(build) {
    build.onEnd(async (r) => {
      if (r.errors.length) return;
      const html = injectAssets(await readFile("web/index.html", "utf8"), {
        js: "assets/app.js",
        css: "assets/app.css",
      });
      await writeFile(`${OUTDIR}/index.html`, html);
      console.log(`[esbuild] rebuilt ${new Date().toLocaleTimeString()}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: [
    { in: "web/src/main.ts", out: "app" },
    { in: "web/styles/app.css", out: "app" },
  ],
  bundle: true,
  sourcemap: "inline",
  format: "esm",
  target: "es2022",
  entryNames: "assets/[name]",
  outdir: OUTDIR,
  logLevel: "info",
  plugins: [writeIndex],
});
await ctx.watch();

const pb = spawn(
  "bin/pocketbase",
  [
    "serve",
    "--dev",
    `--http=127.0.0.1:${PORT}`,
    "--dir=pb_data",
    `--publicDir=${OUTDIR}`,
    "--migrationsDir=pb_migrations",
    "--hooksDir=pb_hooks",
  ],
  { stdio: "inherit" },
);

let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  pb.kill("SIGTERM");
  await ctx.dispose();
  process.exit(code);
};

pb.on("exit", (code) => {
  if (!stopping) {
    console.error(`pocketbase exited (${code}). Did you run \`npm run setup\`?`);
    void stop(code ?? 1);
  }
});
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
