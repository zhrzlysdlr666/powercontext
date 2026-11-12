// 量化前后检索质量对比：fp32 基线模型 vs INT8 量化模型
// 用法：node bench/quality.mjs
// 产出：bench/quality.json
import { pipeline, env } from '@huggingface/transformers';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MODELS_FP32 = process.env.MODELS_FP32_DIR
  ? resolve(process.env.MODELS_FP32_DIR)
  : join(ROOT, 'models-src');
const MODELS_Q8 = process.env.MODELS_Q8_DIR
  ? resolve(process.env.MODELS_Q8_DIR)
  : join(ROOT, 'public', 'models');
const OUT = process.env.OUT_JSON ? resolve(process.env.OUT_JSON) : join(HERE, 'quality.json');

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;

// ---------- 语料 ----------
const corpusText = readFileSync(join(ROOT, 'samples', 'corpus.txt'), 'utf8');
const chunks = corpusText
  .split(/\n\s*\n/)
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length >= 12);

// ---------- 标注查询集（targets 为 0 基块号，可多个）----------
const QUERIES = [
  { q: '云服务订阅收入增长了多少', targets: [0] },
  { q: '净利润为什么下滑', targets: [1] },
  { q: '研发费用率有什么变化', targets: [2] },
  { q: '文档先在本地完成向量化再写入存储', targets: [4] },
  { q: '在浏览器里跑模型有什么好处', targets: [5] },
  { q: 'HNSW 索引是怎么加速查询的', targets: [6, 7] },
  { q: '中文分词器怎么切词', targets: [8] },
  { q: '向量距离和全文得分怎么加权融合', targets: [9] },
  { q: '进程被强杀后已提交的事务还在吗', targets: [10, 24] },
  { q: '向量维度不一致时应该怎么报错', targets: [13] },
  { q: '带过滤条件的向量检索先过滤还是先取 TopK', targets: [14] },
  { q: 'INT8 量化能压缩多少体积', targets: [16] },
  { q: 'WebGPU 和 WebAssembly 哪个更快', targets: [17, 18] },
  { q: '批量推理怎么设置批大小', targets: [19] },
  { q: '文档切块大小设多少合适', targets: [21] },
  { q: '首次加载量化模型要多久', targets: [22] },
  { q: '敏感资料不上传云端怎么做', targets: [23] },
  { q: '评测检索系统看哪些指标', targets: [15] },
];

// ---------- 工具 ----------
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosine(a, b) {
  const na = norm(a), nb = norm(b);
  return na && nb ? dot(a, b) / (na * nb) : 0;
}
function argSort(scores) {
  return scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]).map((x) => x[1]);
}

async function embedAll(modelDir, dtype, texts) {
  env.localModelPath = modelDir;
  const t0 = Date.now();
  const pipe = await pipeline('feature-extraction', 'bge-small-zh-v1.5', {
    dtype,
    device: 'cpu',
  });
  const loadMs = Date.now() - t0;

  const out = [];
  const t1 = Date.now();
  for (const t of texts) {
    const r = await pipe(t, { pooling: 'mean', normalize: true });
    out.push(Array.from(r.data));
  }
  const embedMs = Date.now() - t1;
  return { pipe, vecs: out, loadMs, embedMs };
}

// ---------- 主流程 ----------
const ftPath = join(MODELS_Q8, 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx');
const fp32Path = join(MODELS_FP32, 'bge-small-zh-v1.5', 'onnx', 'model.onnx');
const sizeQ8 = statSync(ftPath).size;
const sizeFp32 = statSync(fp32Path).size;

const allTexts = [...chunks, ...QUERIES.map((x) => x.q)];

console.log(`语料块 ${chunks.length} 段，查询 ${QUERIES.length} 条`);
console.log(`fp32 ${(sizeFp32 / 1048576).toFixed(2)} MB / q8 ${(sizeQ8 / 1048576).toFixed(2)} MB（压缩比 ${(sizeFp32 / sizeQ8).toFixed(2)}×）`);

console.log('\n[1/2] 加载 fp32 基线模型并向量化…');
const A = await embedAll(MODELS_FP32, 'fp32', allTexts);
console.log(`    load ${A.loadMs} ms，embed ${A.embedMs} ms（${allTexts.length} 条）`);

console.log('[2/2] 加载 INT8 量化模型并向量化…');
const B = await embedAll(MODELS_Q8, 'q8', allTexts);
console.log(`    load ${B.loadMs} ms，embed ${B.embedMs} ms（${allTexts.length} 条）`);

const dim = A.vecs[0].length;
const docA = A.vecs.slice(0, chunks.length);
const docB = B.vecs.slice(0, chunks.length);

// 逐块余弦一致性（衡量量化对向量方向的影响）
let csSum = 0, csMin = 1, csMax = -1;
const csPer = [];
for (let i = 0; i < docA.length; i++) {
  const c = cosine(docA[i], docB[i]);
  csPer.push(c);
  csSum += c;
  if (c < csMin) csMin = c;
  if (c > csMax) csMax = c;
}
const csMean = csSum / docA.length;

// 逐查询对比
let top1Agree = 0;
let recall5A = 0, recall5B = 0;
let mrrA = 0, mrrB = 0;
let overlapSum = 0;
const perQuery = [];

for (let qi = 0; qi < QUERIES.length; qi++) {
  const { q, targets } = QUERIES[qi];
  const qa = A.vecs[chunks.length + qi];
  const qb = B.vecs[chunks.length + qi];

  const sa = docA.map((d) => cosine(qa, d));
  const sb = docB.map((d) => cosine(qb, d));
  const ra = argSort(sa);
  const rb = argSort(sb);

  const eq = ra[0] === rb[0];
  if (eq) top1Agree++;

  const setA = new Set(ra.slice(0, 5));
  const setB = new Set(rb.slice(0, 5));
  let inter = 0;
  for (const x of setB) if (setA.has(x)) inter++;
  overlapSum += inter / 5;

  const hitA = targets.filter((t) => setA.has(t)).length > 0;
  const hitB = targets.filter((t) => setB.has(t)).length > 0;
  if (hitA) recall5A++;
  if (hitB) recall5B++;

  const firstA = ra.findIndex((x) => targets.includes(x));
  const firstB = rb.findIndex((x) => targets.includes(x));
  mrrA += firstA >= 0 ? 1 / (firstA + 1) : 0;
  mrrB += firstB >= 0 ? 1 / (firstB + 1) : 0;

  perQuery.push({
    query: q,
    targets,
    fp32_top5: ra.slice(0, 5),
    q8_top5: rb.slice(0, 5),
    top1_same: eq,
    top5_overlap: inter / 5,
    fp32_hit5: hitA,
    q8_hit5: hitB,
    fp32_rank: firstA >= 0 ? firstA + 1 : null,
    q8_rank: firstB >= 0 ? firstB + 1 : null,
    query_vec_cosine: cosine(qa, qb),
  });
}

const N = QUERIES.length;
const report = {
  generated_at: new Date().toISOString(),
  dim,
  chunks: chunks.length,
  queries: N,
  model: {
    name: 'bge-small-zh-v1.5',
    fp32_bytes: sizeFp32,
    q8_bytes: sizeQ8,
    compression_ratio: +(sizeFp32 / sizeQ8).toFixed(3),
  },
  timing_ms: {
    fp32_load: A.loadMs,
    q8_load: B.loadMs,
    fp32_embed_total: A.embedMs,
    q8_embed_total: B.embedMs,
    fp32_embed_per_text: +(A.embedMs / allTexts.length).toFixed(2),
    q8_embed_per_text: +(B.embedMs / allTexts.length).toFixed(2),
  },
  embedding_fidelity: {
    cosine_mean: +csMean.toFixed(6),
    cosine_min: +csMin.toFixed(6),
    cosine_max: +csMax.toFixed(6),
  },
  retrieval: {
    top1_agreement: +(top1Agree / N).toFixed(4),
    top5_overlap: +(overlapSum / N).toFixed(4),
    fp32_recall_at_5: +(recall5A / N).toFixed(4),
    q8_recall_at_5: +(recall5B / N).toFixed(4),
    fp32_mrr: +(mrrA / N).toFixed(4),
    q8_mrr: +(mrrB / N).toFixed(4),
  },
  per_query: perQuery,
};

writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

console.log('\n===== 结果 =====');
console.log(`向量维度 ${dim}`);
console.log(`逐块余弦一致性  mean ${csMean.toFixed(6)}  min ${csMin.toFixed(6)}  max ${csMax.toFixed(6)}`);
console.log(`Top1 一致率      ${(top1Agree / N * 100).toFixed(1)}%`);
console.log(`Top5 重合率      ${(overlapSum / N * 100).toFixed(1)}%`);
console.log(`Recall@5         fp32 ${(recall5A / N * 100).toFixed(1)}%  |  q8 ${(recall5B / N * 100).toFixed(1)}%`);
console.log(`MRR              fp32 ${(mrrA / N).toFixed(4)}  |  q8 ${(mrrB / N).toFixed(4)}`);
console.log(`向量化耗时/条     fp32 ${(A.embedMs / allTexts.length).toFixed(2)} ms  |  q8 ${(B.embedMs / allTexts.length).toFixed(2)} ms`);
console.log(`\n明细已写入 bench/quality.json`);
