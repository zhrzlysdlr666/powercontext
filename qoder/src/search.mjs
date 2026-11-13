// StudyLens 检索：query -> seekdb 全文检索（IK 分词 + BM25 相关度）
// 用法：
//   node src/search.mjs "中文分词 召回"
//   node src/search.mjs --export          # 跑预设查询集，产出 web/data/index.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, stats } from "./db.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const PRESET = [
  "中文分词器怎么选",
  "倒排索引 词项 查找",
  "BM25 相关度打分",
  "RAG 召回质量",
  "切片策略 语义边界",
  "混合检索 RRF",
  "seekdb 内存预算",
  "全文索引 增量更新",
  "执行计划 回表",
  "并行度 瓶颈 CPU",
  "基准测试 噪声 中位数",
  "评分 权重 边际收益",
];

function plain(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

async function search(db, q, limit = 6) {
  const [rows] = await db.query(
    `SELECT doc, topic, heading, body,
            MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
     FROM study_docs
     WHERE MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE)
     ORDER BY score DESC
     LIMIT ?`,
    [q, q, limit],
  );
  return rows.map((r) => ({
    doc: r.doc,
    topic: r.topic,
    heading: r.heading,
    score: Number(Number(r.score).toFixed(3)),
    // 正文里拼过标题，展示时去掉重复的开头
    snippet: plain(String(r.body).replace(r.heading, "")).slice(0, 220),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const db = await openDb();

  if (args[0] === "--export") {
    const [allRows] = await db.query(
      "SELECT doc, topic, heading, body FROM study_docs ORDER BY topic, doc, id",
    );
    const docs = {};
    for (const r of allRows) {
      docs[r.doc] = docs[r.doc] || { doc: r.doc, topic: r.topic, chunks: 0 };
      docs[r.doc].chunks += 1;
    }
    const queries = [];
    // 预热：首次查询要装载 IK 词典与索引块，冷启动耗时不代表检索性能
    for (const q of PRESET) await search(db, q, 6);
    for (const q of PRESET) {
      const t0 = process.hrtime.bigint();
      const hits = await search(db, q, 6);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      queries.push({ q, latencyMs: Number(ms.toFixed(3)), hits });
      console.log(`${q}  ${hits.length} hits  ${ms.toFixed(2)}ms  top=${hits[0] ? hits[0].heading : "-"}`);
    }
    const out = {
      generatedAt: new Date().toISOString(),
      engine: "seekdb (FULLTEXT + IK parser, BM25)",
      totalChunks: allRows.length,
      stats: await stats(),
      documents: Object.values(docs),
      // 全量切片一并导出：站点内任意关键词可做本地近似检索，预置查询则是 seekdb 的真实命中
      chunks: allRows.map((r) => ({
        doc: r.doc,
        topic: r.topic,
        heading: r.heading,
        body: plain(r.body).slice(0, 700),
      })),
      queries,
    };
    const dir = path.join(ROOT, "web", "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(out, null, 1), "utf8");
    console.log(`\n导出 web/data/index.json  切片=${allRows.length}  查询=${queries.length}`);
    await closeDb();
    return;
  }

  const q = args.join(" ").trim();
  if (!q) {
    console.error('用法: node src/search.mjs "查询词"   或   node src/search.mjs --export');
    process.exit(1);
  }
  const t0 = process.hrtime.bigint();
  const hits = await search(db, q, 8);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`查询: ${q}   ${hits.length} 条   ${ms.toFixed(2)}ms\n`);
  for (const h of hits) {
    console.log(`[${h.score}] ${h.heading}  <${h.doc}>`);
    console.log(`   ${h.snippet}\n`);
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
