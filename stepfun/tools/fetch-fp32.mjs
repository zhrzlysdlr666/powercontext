// Fetch the FP32 baseline model in ranged chunks so a flaky link can resume.
// Only needed for `npm run eval`, never for running the app.
//
//   node tools/fetch-fp32.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = path.join(ROOT, ".cache", "models", "bge-small-zh-v1.5", "onnx");
const FILE = path.join(DIR, "model.onnx");
const PART = `${FILE}.part`;
const URL_ = "https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model.onnx";
const CHUNK = 5 * 1024 * 1024;

fs.mkdirSync(DIR, { recursive: true });

const head = await fetch(URL_, { method: "HEAD", redirect: "follow" });
const total = Number(head.headers.get("content-length"));
if (!total) throw new Error("no content-length");
if (fs.existsSync(FILE) && fs.statSync(FILE).size === total) {
  console.log(`already complete: ${(total / 1048576).toFixed(1)} MiB`);
  process.exit(0);
}

let offset = fs.existsSync(PART) ? fs.statSync(PART).size : 0;
console.log(`target ${(total / 1048576).toFixed(1)} MiB, starting at ${(offset / 1048576).toFixed(1)} MiB`);

const out = fs.openSync(PART, offset ? "a" : "w");
while (offset < total) {
  const end = Math.min(offset + CHUNK - 1, total - 1);
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(URL_, { headers: { range: `bytes=${offset}-${end}` }, redirect: "follow" });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeSync(out, buf);
      offset += buf.length;
      process.stdout.write(`\r${(offset / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`);
      break;
    } catch (error) {
      attempt += 1;
      if (attempt > 4) throw error;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
fs.closeSync(out);
fs.renameSync(PART, FILE);
console.log(`\nwritten ${FILE}`);
