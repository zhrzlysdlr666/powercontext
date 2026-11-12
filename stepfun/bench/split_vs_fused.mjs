// 对照实验：单条 SQL 融合 vs 分两路查询再合并
// 用法：node bench/split_vs_fused.mjs [baseUrl]
// 说明：split 路径只用于测量「客户端拼合」的代价，应用实际只走 /api/search。
import { pipeline, env } from '@huggingface/transformers';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const KB = process.env.KB_NAME || 'default';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = join(ROOT, 'public', 'models');

const QUERIES = [
  '云服务订阅收入为什么增长',
  '净利润下滑的一次性因素',
  '研发投入的方向',
  '现金流与资本开支',
  '端侧推理为什么要在浏览器里跑',
  'WebGPU 与 WebAssembly 的差异',
  'HNSW 索引的取舍',
  '中文分词怎么做',
  '向量和全文如何融合',
  '崩溃恢复依赖什么机制',
  '批量写入的事务大小',
  '向量索引的增量维护',
  '向量列的维度校验',
  '过滤条件与 TopK 的先后',
  'Recall@K 与 nDCG 的区别',
  'INT8 量化的体积收益',
  '降级策略怎么设计',
  '批处理为什么能提升吞吐',
  '索引刷新与可见性',
  '文档切块大小怎么选',
];

const pipe = await pipeline('feature-extraction', 'bge-small-zh-v1.5', { dtype: 'q8', device: 'cpu' });
const embed = async (t) => (await pipe([t], { pooling: 'mean', normalize: true })).tolist()[0];

const call = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};
const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const rows = [];
for (const q of QUERIES) {
  const vector = await embed(q);
  const fused = await call('/api/search', { kb: KB, vector, text: q, k: 5 });
  const split = await call('/api/_bench/split', { kb: KB, vector, text: q, k: 5 });
  const a = new Set(fused.hits.map((h) => h.id));
  const b = new Set(split.hits.map((h) => h.id));
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  rows.push({
    q,
    fused_ms: fused.db_query_ms,
    split_ms: split.db_query_ms,
    top5_overlap: inter,
    top1_same: fused.hits[0]?.id === split.hits[0]?.id,
  });
}

const f = median(rows.map((r) => r.fused_ms));
const s = median(rows.map((r) => r.split_ms));
const overlap = rows.reduce((acc, r) => acc + r.top5_overlap, 0) / rows.length;
const top1 = rows.filter((r) => r.top1_same).length;

console.log(`查询 ${rows.length} 条，库「${KB}」`);
console.log(`单条 SQL 融合      中位数 ${f.toFixed(2)} ms`);
console.log(`两路查询 + 客户端合并  中位数 ${s.toFixed(2)} ms  （${(s / f).toFixed(2)}× 融合方案）`);
console.log(`Top5 结果重合 ${overlap.toFixed(2)}/5，Top1 一致 ${top1}/${rows.length}`);
const out = {
  generated_at: new Date().toISOString(),
  kb: KB,
  queries: rows.length,
  fused_median_ms: +f.toFixed(3),
  split_median_ms: +s.toFixed(3),
  ratio: +(s / f).toFixed(3),
  top5_overlap_mean: +overlap.toFixed(3),
  top1_same: top1,
  per_query: rows,
};
const fs = await import('node:fs');
fs.writeFileSync(join(ROOT, 'bench', 'split_vs_fused.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('明细：bench/split_vs_fused.json');
