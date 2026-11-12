// 增量写入 / 索引刷新 / 集合隔离 的功能验证（直接打 HTTP 接口，向量在 Node 侧用同一个 INT8 模型生成）
// 用法：先 npm start，再 node bench/refresh_test.mjs [baseUrl]
import { pipeline, env } from '@huggingface/transformers';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:5180';
const KB_A = `t${Date.now().toString(36)}a`;
const KB_B = `t${Date.now().toString(36)}b`;

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = join(ROOT, 'public', 'models');

const pipe = await pipeline('feature-extraction', 'bge-small-zh-v1.5', { dtype: 'q8', device: 'cpu' });
const embed = async (texts) => {
  const out = await pipe(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
};

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};
const get = async (p) => (await fetch(BASE + p)).json();

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  —  ' + extra : ''}`);
};

const docs = [
  { id: `${KB_A}#0`, title: '番茄种植', text: '番茄需要充足日照和疏松土壤，浇水保持见干见湿，结果期追加钾肥。' },
  { id: `${KB_A}#1`, title: '咖啡烘焙', text: '浅烘焙保留更多果酸，深烘焙带来焦糖与坚果风味，烘焙曲线决定最终口感。' },
  { id: `${KB_A}#2`, title: '登山装备', text: '登山鞋要选防水透气款，背包容量按行程天数选择，冰爪用于硬雪与冰面。' },
];

// 1) 首次导入 + 立刻可检索（索引刷新）
const vecs = await embed(docs.map((d) => d.text));
const t0 = Date.now();
const ing = await post('/api/ingest', { kb: KB_A, docs: docs.map((d, i) => ({ ...d, source: 'refresh_test', vector: vecs[i] })) });
const ingestMs = Date.now() - t0;
check('首次导入 3 块', ing.inserted === 3 && ing.total === 3, `写入 ${ingestMs} ms / 服务端 ${ing.db_write_ms.toFixed(1)} ms`);

const qVec = (await embed(['咖啡怎么烘焙才好喝']))[0];
const s1 = await post('/api/search', { kb: KB_A, vector: qVec, text: '咖啡怎么烘焙才好喝', k: 3 });
check('导入后立即检索到（无需手动刷新索引）', s1.hits.some((h) => h.id === `${KB_A}#1`), `top1=${s1.hits[0]?.id} score=${s1.hits[0]?.score}`);

// 2) 增量写入：只追加 1 块，历史数据不丢
const inc = { id: `${KB_A}#3`, title: '光伏逆变器', text: '光伏逆变器把直流电转换为交流电，效率与散热设计直接影响发电量。' };
const incVec = (await embed([inc.text]))[0];
await post('/api/ingest', { kb: KB_A, docs: [{ ...inc, source: 'refresh_test', vector: incVec }] });
const qVec2 = (await embed(['逆变器把直流变成交流']))[0];
const s2 = await post('/api/search', { kb: KB_A, vector: qVec2, text: '逆变器把直流变成交流', k: 5 });
check('增量写入后新内容可检索', s2.hits.some((h) => h.id === `${KB_A}#3`), `命中 ${s2.hits.length} 条`);
const h1 = await get(`/api/health?kb=${KB_A}`);
check('增量写入后总量正确', h1.docs === 4, `docs=${h1.docs}`);

// 3) 同 id 更新：内容覆盖，不产生重复行
const upd = { ...inc, title: '光伏逆变器（修订）', text: '光伏逆变器把直流电转换为交流电，过载保护与并网谐波是两项关键指标。' };
const updVec = (await embed([upd.text]))[0];
await post('/api/ingest', { kb: KB_A, docs: [{ ...upd, source: 'refresh_test', vector: updVec }] });
const h2 = await get(`/api/health?kb=${KB_A}`);
const s3 = await post('/api/search', { kb: KB_A, vector: updVec, text: '并网谐波', k: 5 });
check('同 id 覆盖更新不重复', h2.docs === 4 && s3.hits[0]?.text.includes('并网谐波'), `docs=${h2.docs}`);

// 4) 集合隔离
const bDocs = [{ id: `${KB_B}#0`, title: '咖啡机保养', text: '咖啡机每月除垢一次，冲煮头每日反冲洗，磨豆机刀盘定期清理残粉。' }];
const bVec = (await embed([bDocs[0].text]))[0];
await post('/api/ingest', { kb: KB_B, docs: [{ ...bDocs[0], source: 'refresh_test', vector: bVec }] });
const sA = await post('/api/search', { kb: KB_A, vector: qVec, text: '咖啡怎么烘焙才好喝', k: 10 });
const sB = await post('/api/search', { kb: KB_B, vector: qVec, text: '咖啡怎么烘焙才好喝', k: 10 });
check('集合隔离：A 库看不到 B 库内容', !sA.hits.some((h) => h.id.startsWith(KB_B)), `A 命中 ${sA.hits.length} 条`);
check('集合隔离：B 库只返回自己的内容', sB.hits.length > 0 && sB.hits.every((h) => h.id.startsWith(KB_B)), `B 命中 ${sB.hits.length} 条`);
const cols = await get('/api/collections');
check('集合列表包含新建的两个库', [KB_A, KB_B].every((k) => cols.collections.some((c) => c.kb === k)), JSON.stringify(cols.collections.map((c) => `${c.kb}:${c.docs}`)));

// 5) 清理
await post('/api/reset', { kb: KB_A });
await post('/api/reset', { kb: KB_B });
const hEnd = await get(`/api/health?kb=${KB_A}`);
check('清空当前库后计数归零', hEnd.docs === 0, `docs=${hEnd.docs}`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
