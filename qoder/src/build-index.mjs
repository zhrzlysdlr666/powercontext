// 从 content/ 重建 web/data/index.json —— 零依赖，不需要 seekdb 运行时。
//
// 与 ingest.mjs 完全一致的切块规则（按二级标题切、标题拼进正文、正文过短丢弃），
// 与 web/index.html 完全一致的 BM25 参数（k1=1.2, b=0.75, idf=log(1+(N-df+0.5)/(df+0.5))，
// 中文按 bigram 切分），因此离线导出的打分与线上页面逐位一致。
//
//   node src/build-index.mjs
//
// 有 seekdb 运行时的时候，推荐用 `node src/search.mjs --export` 走真实
// FULLTEXT ... AGAINST 取分；两条路径产出同一个数据格式，页面无需区分。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTENT = path.join(ROOT, "content");
const OUT = path.join(ROOT, "web", "data", "index.json");

const TOPIC_BY_PREFIX = {
  "01": "全文检索",
  "02": "seekdb",
  "03": "RAG",
  "04": "性能调优",
  "05": "备赛方法",
  "06": "工作提效",
  "07": "项目管理",
  "08": "学习方法",
  "09": "科研方法",
  "10": "资料检索",
  "11": "数据处理",
  "12": "协作沟通",
  "13": "自动化",
};

// 预置查询：首条是页面首屏，其余进基准表与检索建议。
const PRESET = [
  "中文分词器怎么选",
  "报表自动化",
  "项目进度跟踪",
  "项目资料查找",
  "文献综述怎么读",
  "会议纪要怎么写",
  "数据清洗顺序",
  "定时任务失败重试",
  "倒排索引",
  "倒排索引 词项",
  "BM25 权重",
  "工作提效",
];

const K1 = 1.2;
const B = 0.75;

function chunksOf(markdown) {
  const parts = markdown.split(/\n(?=##\s)/);
  const head = parts.shift() || "";
  const docTitle = ((head.match(/^#\s*(.+)$/m) || [])[1] || "未命名资料").trim();
  const out = [];
  for (const part of parts) {
    const heading = ((part.match(/^##\s*(.+)$/m) || [])[1] || "").trim();
    const body = part.replace(/^##\s*.+$/m, "").trim();
    if (!heading || body.length < 40) continue;
    out.push({ heading, body });
  }
  if (!out.length && head.trim()) out.push({ heading: "概述", body: head.trim() });
  return { docTitle, chunks: out };
}

// 与页面 terms() 逐字一致：ASCII 整词，中文 bigram（单字词保留自身）
export function terms(q) {
  const s = String(q)
    .toLowerCase()
    .replace(/[，。、；：？！“”‘’（）《》【】,.;:?!"'()\[\]<>]/g, " ")
    .trim();
  const out = new Set();
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (/^[\x00-\x7f]+$/.test(w)) out.add(w);
    else {
      if (w.length === 1) out.add(w);
      for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    }
  }
  return [...out];
}

function buildBm25(chunks) {
  const postings = new Map();
  const df = new Map();
  const lengths = [];
  chunks.forEach((c, i) => {
    const text = (c.heading + " " + c.heading + " " + c.body).toLowerCase();
    const ts = terms(text);
    const tf = new Map();
    let dl = 0;
    for (const t of ts) {
      tf.set(t, (tf.get(t) || 0) + 1);
      dl += 1;
    }
    lengths.push(dl || 1);
    for (const [t, n] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([i, n]);
      df.set(t, (df.get(t) || 0) + 1);
    }
  });
  const avgdl = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  return { postings, df, lengths, avgdl, N: chunks.length };
}

function search(index, chunks, q, limit = 8) {
  const ts = terms(q);
  if (!ts.length) return [];
  const { postings, df, lengths, avgdl, N } = index;
  const scores = new Map();
  for (const t of ts) {
    const list = postings.get(t);
    if (!list) continue;
    const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
    for (const [i, tf] of list) {
      const dl = lengths[i];
      const cur = scores.get(i) || 0;
      scores.set(i, cur + (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * dl) / avgdl)));
    }
  }
  const q0 = String(q).toLowerCase().replace(/\s+/g, "");
  return chunks
    .map((c, i) => {
      const base = scores.get(i) || 0;
      const head = String(c.heading).toLowerCase().includes(q0) ? 1.5 : 0;
      const doc = head ? 0 : String(c.doc).toLowerCase().includes(q0) ? 0.9 : 0;
      const fuzzy = base || head || doc ? 0 : overlap(c, ts) * 0.6;
      return { i, score: Number((base + head + doc + fuzzy).toFixed(3)) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || chunks[a.i].heading.length - chunks[b.i].heading.length)
    .slice(0, limit);
}

function overlap(c, ts) {
  const chars = [...new Set(ts.join(""))].filter((x) => x.trim());
  if (!chars.length) return 0;
  const text = (c.heading + " " + c.body).toLowerCase();
  let hit = 0;
  for (const ch of chars) if (text.includes(ch)) hit += 1;
  return hit / chars.length;
}

const snippet = (c, n = 128) => {
  const body = c.body.startsWith(c.heading) ? c.body.slice(c.heading.length).trim() : c.body;
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n) + "…";
};

function main() {
  const files = fs.readdirSync(CONTENT).filter((f) => f.endsWith(".md")).sort();
  const chunks = [];
  const documents = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(CONTENT, file), "utf8");
    const { docTitle, chunks: cs } = chunksOf(raw);
    const topic = TOPIC_BY_PREFIX[file.slice(0, 2)] || "其他";
    for (const c of cs) {
      chunks.push({ doc: docTitle, topic, heading: c.heading, body: `${c.heading}\n\n${c.body}` });
    }
    documents.push({ doc: docTitle, topic, chunks: cs.length });
  }

  const index = buildBm25(chunks);

  const topicCount = new Map();
  for (const c of chunks) topicCount.set(c.topic, (topicCount.get(c.topic) || 0) + 1);
  const stats = [...topicCount.entries()]
    .map(([topic, n]) => ({ topic, n }))
    .sort((a, b) => b.n - a.n);

  const queries = PRESET.map((q) => {
    const t0 = process.hrtime.bigint();
    const hits = search(index, chunks, q, 8);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      q,
      latencyMs: Number(ms.toFixed(3)),
      hits: hits.map((h) => ({
        doc: chunks[h.i].doc,
        topic: chunks[h.i].topic,
        heading: chunks[h.i].heading,
        score: h.score,
        snippet: snippet(chunks[h.i]),
      })),
    };
  });

  const data = {
    generatedAt: new Date().toISOString(),
    engine: "seekdb FULLTEXT (ik parser) + BM25；离线导出路径复算同一套参数",
    totalChunks: chunks.length,
    stats,
    documents,
    chunks,
    queries,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 1) + "\n", "utf8");

  console.log(`chunks=${chunks.length} docs=${documents.length} -> ${path.relative(ROOT, OUT)}`);
  for (const q of queries) {
    const zero = q.hits.length === 0 ? "  ⚠ 0 命中" : "";
    console.log(`  ${q.q.padEnd(18, " ")} ${String(q.hits.length).padStart(2)} 条 ${q.latencyMs.toFixed(2)}ms${zero}`);
  }
}

main();
