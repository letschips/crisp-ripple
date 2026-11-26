import esbuild from "esbuild";
import builtins from "builtin-modules";
import { readFile } from "node:fs/promises";
import process from "node:process";

const production = process.argv[2] === "production";
const license = await readFile(new URL("./src/vendor/ascii-sharks/LICENSE", import.meta.url), "utf8");
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  banner: { js: `/*! ascii-sharks\n${license.trim()}\n*/` },
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
