// 把 content/ 下的 Markdown 学习资料切块写入 seekdb。
// 切块策略：按二级标题切；标题拼进正文（提升检索命中）；(doc, heading) 唯一键保证幂等。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeDb, stats } from "./db.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CONTENT = path.join(ROOT, "content");

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

async function main() {
  const db = await openDb();
  const files = fs.readdirSync(CONTENT).filter((f) => f.endsWith(".md")).sort();
  let written = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(CONTENT, file), "utf8");
    const { docTitle, chunks } = chunksOf(raw);
    const topic = TOPIC_BY_PREFIX[file.slice(0, 2)] || "其他";
    for (const c of chunks) {
      // 标题拼进正文：切片正文常常看不出上下文，拼标题后检索命中更准
      const body = `${c.heading}\n\n${c.body}`;
      await db.query(
        `INSERT INTO study_docs (doc, topic, heading, body)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE topic=VALUES(topic), body=VALUES(body),
           updated_at=CURRENT_TIMESTAMP`,
        [docTitle, topic, c.heading, body],
      );
      written += 1;
    }
    console.log(`+ ${file}  ${docTitle}  chunks=${chunks.length}`);
  }
  const s = await stats();
  console.log(`\n写入 ${written} 个切片`);
  for (const row of s) console.log(`  ${row.topic}: ${row.n}`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
