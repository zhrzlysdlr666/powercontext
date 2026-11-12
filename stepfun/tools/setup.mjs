// One-time setup: vendor the browser runtime and cache the ONNX model locally.
//
//   npm run setup
//
// The app performs every embedding on the user's device. Fetching the model
// files during setup does not move the computation off the device: after this
// script finishes the app runs with the network switched off.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const VENDOR = path.join(ROOT, "web", "vendor");
const MODELS = path.join(ROOT, "web", "models");

const TF = path.join(ROOT, "node_modules", "@huggingface", "transformers", "dist");
const VENDOR_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

const MODEL_REPO = process.env.MODEL_REPO || "Xenova/bge-small-zh-v1.5";
const MIRRORS = (process.env.HF_MIRRORS || "https://hf-mirror.com,https://huggingface.co")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  // INT8 for the CPU (WASM) path.
  "onnx/model_quantized.onnx",
];

// The quantised weights cannot run on the WebGPU execution provider — ONNX
// Runtime has no integer kernels there, and the graph silently computes the
// wrong vector (measured cosine 0.29 against the CPU result). WebGPU therefore
// gets the half precision build, which is why it is fetched as well.
const FP16_FILE = "onnx/model_fp16.onnx";

function copyVendor() {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const f of VENDOR_FILES) {
    const src = path.join(TF, f);
    if (!fs.existsSync(src)) throw new Error(`missing ${src} — run npm install first`);
    fs.copyFileSync(src, path.join(VENDOR, f));
    const mb = (fs.statSync(src).size / 1048576).toFixed(1);
    console.log(`vendor  ${f.padEnd(38)} ${mb} MiB`);
  }
}

async function download(file) {
  const dest = path.join(MODELS, MODEL_REPO.split("/")[1], file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`skip    ${file} (already present)`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastError;
  for (const base of MIRRORS) {
    const url = `${base}/${MODEL_REPO}/resolve/main/${file}`;
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buf);
      console.log(`model   ${file.padEnd(38)} ${(buf.length / 1048576).toFixed(2)} MiB`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`  ${base} failed for ${file}: ${error.message}`);
    }
  }
  throw new Error(`cannot download ${file}: ${lastError?.message}`);
}

copyVendor();
execFileSync(process.execPath, [path.join(ROOT, "tools", "bundle-runtime.mjs")], { stdio: "inherit" });
for (const f of MODEL_FILES) await download(f);
if (process.env.SKIP_FP16 !== "1") await download(FP16_FILE);
console.log("\nready. start the app with:  npm start");
