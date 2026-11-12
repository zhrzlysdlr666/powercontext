// Bundle the browser runtime into one self-contained ES module.
//
// @huggingface/transformers ships a browser build that still imports the bare
// specifiers "onnxruntime-common" / "onnxruntime-web", which a plain <script
// type="module"> cannot resolve without an import map. Bundling here keeps the
// served app dependency-free: web/vendor/transformers.bundle.js plus the ORT
// wasm next to it.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENTRY = path.join(ROOT, "tools", "runtime-entry.js");
const OUT = path.join(ROOT, "web", "vendor", "transformers.bundle.js");

fs.writeFileSync(
  ENTRY,
  'export { pipeline, env, AutoTokenizer, AutoModel } from "@huggingface/transformers";\n',
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "edge110"],
  minify: true,
  legalComments: "none",
  outfile: OUT,
  define: { "process.env.NODE_ENV": '"production"' },
});

fs.rmSync(ENTRY, { force: true });
console.log(`bundle  ${path.relative(ROOT, OUT)}  ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MiB`);
