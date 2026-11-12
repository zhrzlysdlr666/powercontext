// Vendor the ONNX model + tokenizer locally so the app runs fully offline.
// usage: node tools/fetch-model.mjs [repo] [files...]
import fs from "node:fs";
import path from "node:path";

const REPO = process.env.MODEL_REPO || "Xenova/bge-small-zh-v1.5";
const MIRROR = process.env.HF_MIRROR || "https://hf-mirror.com";
const OUT = path.join(process.cwd(), "web", "models", REPO.split("/")[1]);
const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

async function grab(file) {
  const url = `${MIRROR}/${REPO}/resolve/main/${file}`;
  const dest = path.join(OUT, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${file} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`${file.padEnd(32)} ${(buf.length / 1048576).toFixed(2)} MiB`);
}

for (const f of FILES) await grab(f);
console.log("saved to", OUT);
