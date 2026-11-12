// 端侧迷你知识库 —— 本地 Node 服务：内嵌 seekdb + 单条 SQL 完成向量与全文混合检索。
//
// 设计要点：
//  * 向量化全部发生在浏览器，服务端只负责存储与检索，不接收任何云端推理结果。
//  * 混合检索在一条 SQL 内完成（MATCH ... AGAINST 与 L2_DISTANCE 加权融合），
//    不在客户端拼两路结果，满足赛题「检索处理由 seekdb 完成」的要求。
//  * 多知识库（collection）隔离：所有读写都带 collection 过滤，切换知识库不影响彼此结果。
import http from 'node:http';
import path from 'node:path';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seekdb } from '@oceanbase/seekdb-node';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.KB_DATA_DIR || path.join(__dirname, 'data');
const DIM = Number(process.env.KB_DIM || 512);
const PORT = Number(process.env.PORT || 5173);
const VEC_WEIGHT = Number(process.env.KB_VEC_WEIGHT || 0.6);
const FT_WEIGHT = Number(process.env.KB_FT_WEIGHT || 0.4);
// 语义召回的距离上限：只允许足够接近的向量进入候选集，避免向量项把无关文档拉进结果。
const MAX_L2 = Number(process.env.KB_MAX_L2 || 1.2);
// 全文分饱和常数：BM25 分数无上界，用 ft/(ft+C) 压到 [0,1) 同时保留区分度，
// 避免直接截断（LEAST(ft,1)）让所有高分文档得分相同。
const FT_SATURATION = Number(process.env.KB_FT_C || 4);
const DEFAULT_KB = 'default';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// 0) 静态依赖自举：把 node_modules 里的 Transformers.js 运行时复制到 public/vendor，
//    这样 `npm install && npm start` 之后浏览器直接能加载，无需手工拷贝。
// ---------------------------------------------------------------------------
async function ensureVendor() {
  const candidates = [
    path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist'),
    path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', 'dist'),
  ];
  const src = candidates.find((p) => existsSync(p));
  const dst = path.join(PUBLIC, 'vendor', 'transformers');
  const files = ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
  if (!src) {
    console.warn('[vendor] 未找到 node_modules/@huggingface/transformers/dist，跳过自举（请先 npm install）');
    return;
  }
  await mkdir(dst, { recursive: true });
  for (const f of files) {
    const to = path.join(dst, f);
    if (existsSync(to)) continue;
    await copyFile(path.join(src, f), to);
    console.log(`[vendor] copied ${f}`);
  }
}
await ensureVendor();

if (!existsSync(path.join(PUBLIC, 'models', 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx'))) {
  console.warn('[model] 未找到 INT8 模型文件，请先执行 `npm run model`（下载 + 量化），否则页面无法推理');
}

// ---------------------------------------------------------------------------
// 1) 启动内嵌 seekdb，建库建表
// ---------------------------------------------------------------------------
const db = await seekdb.open(DATA_DIR, {
  parameters: { memory_budget: process.env.KB_MEMORY || '2G', mysql_port_mode: 'random' },
});
const endpoint = db.connectionOptions();
const conn = await mysql.createConnection({
  host: endpoint.host,
  port: endpoint.port,
  user: endpoint.user,
  password: '',
  database: 'test',
  multipleStatements: false,
});

await conn.query(`CREATE TABLE IF NOT EXISTS kb_docs (
  id VARCHAR(64) PRIMARY KEY,
  kb VARCHAR(64) NOT NULL DEFAULT '${DEFAULT_KB}',
  title VARCHAR(255),
  body MEDIUMTEXT,
  source VARCHAR(255),
  embedding VECTOR(${DIM}),
  FULLTEXT KEY ft_body (title, body) WITH PARSER IK,
  KEY idx_kb (kb)
)`);

// 兼容旧数据目录（表已存在但缺 kb 列）：忽略重复列错误。
try {
  await conn.query(`ALTER TABLE kb_docs ADD COLUMN kb VARCHAR(64) NOT NULL DEFAULT '${DEFAULT_KB}'`);
} catch (err) {
  const msg = String(err.message || '');
  if (!/duplicate column|already exists/i.test(msg)) console.warn('[schema] alter kb:', msg.slice(0, 120));
}

// 向量索引：seekdb 要求显式给出 distance/type/lib。
let vectorIndex = false;
try {
  await conn.query('CREATE VECTOR INDEX vidx_embedding ON kb_docs (embedding) WITH (distance=l2, type=hnsw, lib=vsag)');
  vectorIndex = true;
} catch (err) {
  const msg = String(err.message || '');
  if (/already|exists|has vector index/i.test(msg)) vectorIndex = true;
  else console.error('[seekdb] vector index unavailable:', msg.slice(0, 160));
}

// ---------------------------------------------------------------------------
// 2) 混合检索 SQL：一条语句内同时算全文分与向量分并加权，全部由 seekdb 执行
// ---------------------------------------------------------------------------
const HYBRID_SQL = `
SELECT id, kb, title, body, source,
       MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE) AS ft_score,
       L2_DISTANCE(embedding, ?) AS l2,
       ROUND(?, 4) * (1.0 / (1.0 + L2_DISTANCE(embedding, ?)))
     + ROUND(?, 4) * (MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE)
                      / (MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE) + ${FT_SATURATION})) AS score
  FROM kb_docs
 WHERE kb = ?
   AND (MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE) > 0
        OR L2_DISTANCE(embedding, ?) <= ?)
 ORDER BY score DESC
 LIMIT ?`;

// 仅用于性能对照实验的两条单路 SQL（应用路径从不调用）。
const VEC_ONLY_SQL = `
SELECT id, kb, title, body, source, L2_DISTANCE(embedding, ?) AS l2
  FROM kb_docs WHERE kb = ? AND L2_DISTANCE(embedding, ?) <= ?
 ORDER BY l2 ASC LIMIT ?`;
const FT_ONLY_SQL = `
SELECT id, kb, title, body, source,
       MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE) AS ft_score
  FROM kb_docs WHERE kb = ?
   AND MATCH(title, body) AGAINST(? IN NATURAL LANGUAGE MODE) > 0
 ORDER BY ft_score DESC LIMIT ?`;

// 跨源隔离头：让浏览器开启 SharedArrayBuffer，WASM 后端才能多线程推理。
const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(code, { ...ISOLATION, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function readJson(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const kbName = (v) => String(v || DEFAULT_KB).slice(0, 64) || DEFAULT_KB;

async function ingest(kb, docs) {
  if (!Array.isArray(docs) || docs.length === 0) throw new Error('docs is empty');
  const started = process.hrtime.bigint();
  await conn.beginTransaction();
  try {
    for (const doc of docs) {
      const vec = doc.vector ?? doc.vec;
      if (!Array.isArray(vec) || vec.length !== DIM) throw new Error(`bad vector for ${doc.id}`);
      await conn.query(
        `INSERT INTO kb_docs (id, kb, title, body, source, embedding) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE kb = VALUES(kb), title = VALUES(title), body = VALUES(body),
           source = VALUES(source), embedding = VALUES(embedding)`,
        [doc.id, kb, doc.title || '', doc.text || doc.body || '', doc.source || '', JSON.stringify(vec)]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  }
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb_docs WHERE kb = ?', [kb]);
  return {
    kb,
    inserted: docs.length,
    total: Number(rows[0].n),
    db_write_ms: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

async function search({ kb, vector, text, k = 10, vecWeight, ftWeight }) {
  if (!Array.isArray(vector) || vector.length !== DIM) throw new Error('bad query vector');
  const name = kbName(kb);
  const query = String(text || '');
  const kn = Math.max(1, Math.min(50, Number(k) || 10));
  const vw = Number.isFinite(vecWeight) ? vecWeight : VEC_WEIGHT;
  const fw = Number.isFinite(ftWeight) ? ftWeight : FT_WEIGHT;
  const vstr = JSON.stringify(vector);
  const started = process.hrtime.bigint();
  const [rows] = await conn.query(HYBRID_SQL, [
    query, vstr, vw, vstr, fw, query, query, name, query, vstr, MAX_L2, kn,
  ]);
  const db_ms = Number(process.hrtime.bigint() - started) / 1e6;
  const hits = rows.map((r) => ({
    id: r.id,
    kb: r.kb,
    title: r.title,
    text: r.body,
    source: r.source,
    score: Number(r.score),
    ft_score: Number(r.ft_score),
    l2: Number(r.l2),
  }));
  return { kb: name, hits, db_query_ms: db_ms, weights: { vector: vw, fulltext: fw }, sql: 'kb_docs/hybrid-v2' };
}

// 对照组：分别查向量与全文两路，再在客户端合并 —— 用来量化「单条 SQL 融合」省下的开销。
async function searchSplit({ kb, vector, text, k = 10 }) {
  const name = kbName(kb);
  const kn = Math.max(1, Math.min(50, Number(k) || 10));
  const vstr = JSON.stringify(vector);
  const started = process.hrtime.bigint();
  const [vrows] = await conn.query(VEC_ONLY_SQL, [vstr, name, vstr, MAX_L2, kn]);
  const [frows] = await conn.query(FT_ONLY_SQL, [String(text || ''), name, String(text || ''), kn]);
  const merged = new Map();
  for (const r of vrows) merged.set(r.id, { ...r, score: VEC_WEIGHT * (1 / (1 + Number(r.l2))), ft_score: 0 });
  for (const r of frows) {
    const s = FT_WEIGHT * (Number(r.ft_score) / (Number(r.ft_score) + FT_SATURATION));
    const prev = merged.get(r.id);
    if (prev) prev.score += s;
    else merged.set(r.id, { ...r, l2: null, score: s });
  }
  const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, kn);
  const db_ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { kb: name, hits, db_query_ms: db_ms, mode: 'split-2-queries' };
}

async function collections() {
  const [rows] = await conn.query('SELECT kb, COUNT(*) AS n FROM kb_docs GROUP BY kb ORDER BY n DESC');
  return rows.map((r) => ({ kb: r.kb, docs: Number(r.n) }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      const kb = kbName(url.searchParams.get('kb'));
      const [rows] = await conn.query('SELECT COUNT(*) AS n FROM kb_docs WHERE kb = ?', [kb]);
      const [all] = await conn.query('SELECT COUNT(*) AS n FROM kb_docs');
      return json(res, 200, {
        ok: true,
        dim: DIM,
        kb,
        docs: Number(rows[0].n),
        docs_total: Number(all[0].n),
        collections: await collections(),
        vector_index: vectorIndex,
        weights: { vector: VEC_WEIGHT, fulltext: FT_WEIGHT },
        max_l2: MAX_L2,
      });
    }
    if (url.pathname === '/api/collections') {
      return json(res, 200, { collections: await collections() });
    }
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await ingest(kbName(body.kb), body.docs));
    }
    if (url.pathname === '/api/_bench/split' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await searchSplit(body));
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await search(body));
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const kb = kbName(body.kb);
      await conn.query('DELETE FROM kb_docs WHERE kb = ?', [kb]);
      return json(res, 200, { ok: true, kb });
    }

    if (url.pathname === '/favicon.ico') { res.writeHead(204, ISOLATION); return res.end(); }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const buf = await readFile(file);
    res.writeHead(200, {
      ...ISOLATION,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': path.extname(file) === '.onnx' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(buf);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const code = /ENOENT/.test(msg) ? 404 : 500;
    json(res, code, { error: msg.slice(0, 400) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[kb] http://127.0.0.1:${PORT}  data=${DATA_DIR}  dim=${DIM}  vector_index=${vectorIndex}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await conn.end(); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}
