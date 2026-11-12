// 下载 bge-small-zh-v1.5（fp32 + 分词文件），并准备 public/models 目录。
// 用法：node scripts/fetch-model.mjs
//
// 说明：
//  * 默认走 hf-mirror.com 镜像（国内可直连），可用 HF_ENDPOINT 覆盖。
//  * fp32 模型落到 models-src/ 作为量化输入；量化后的 INT8 模型由
//    `npm run quantize`（scripts/quantize.py）生成并写入 public/models/。
//  * 若没有 Python 量化环境，加 --with-official-int8 可直接取官方 INT8 权重，
//    它同样是 onnxruntime quantize_dynamic(per-channel) 的产物，尺寸与自量化一致。
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
const REPO = 'Xenova/bge-small-zh-v1.5';
const WITH_OFFICIAL_INT8 = process.argv.includes('--with-official-int8');

const SRC_DIR = join(ROOT, 'models-src', 'bge-small-zh-v1.5');
const PUB_DIR = join(ROOT, 'public', 'models', 'bge-small-zh-v1.5');

const COMMON = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json'];

async function download(remote, dest) {
  if (existsSync(dest)) {
    const s = await stat(dest);
    if (s.size > 1024) {
      console.log(`skip  ${dest.replace(ROOT, '.')}  (${(s.size / 1e6).toFixed(2)} MB)`);
      return;
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  const url = `${ENDPOINT}/${REPO}/resolve/main/${remote}`;
  process.stdout.write(`get   ${remote} … `);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const s = await stat(dest);
  console.log(`${(s.size / 1e6).toFixed(2)} MB`);
}

for (const f of COMMON) {
  await download(f, join(PUB_DIR, f));
  await download(f, join(SRC_DIR, f));
}

await download('onnx/model.onnx', join(SRC_DIR, 'onnx', 'model.onnx'));

if (WITH_OFFICIAL_INT8) {
  await download('onnx/model_quantized.onnx', join(PUB_DIR, 'onnx', 'model_quantized.onnx'));
} else if (!existsSync(join(PUB_DIR, 'onnx', 'model_quantized.onnx'))) {
  console.log('\n下一步（需要 python + onnx + onnxruntime）：');
  console.log('  npm run quantize');
  console.log('或直接取官方 INT8 权重：');
  console.log('  node scripts/fetch-model.mjs --with-official-int8');
}

console.log('\n完成。public/models/bge-small-zh-v1.5 为浏览器实际加载的模型目录。');
