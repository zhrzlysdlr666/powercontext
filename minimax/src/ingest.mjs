// 把规格、代码、测试三类工程资料切块写入 seekdb。
// 切块策略：Markdown 按二级标题切，代码按顶层函数/类切，测试按 def 切。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDb } from "./db.mjs";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

function cutMarkdown(text) {
  const parts = text.split(/\n(?=##\s)/);
  const head = parts.shift() || "";
  const title =
    (head.match(/^#\s*(.+)$/m) || [])[1] ||
    (head.match(/编号[:：]\s*(\S+)/) || [])[1] ||
    "未命名规格";
  const chunks = parts.map((p) => {
    const h = (p.match(/^##\s*(.+)$/m) || [])[1] || "";
    return { title: `${title} · ${h}`.trim(), body: p.trim(), symbol: "" };
  });
  return chunks.length ? chunks : [{ title, body: text.trim(), symbol: "" }];
}

function cutPython(text, fileTitle) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = null;
  let curTitle = fileTitle;
  const flush = () => {
    if (cur && cur.length) chunks.push({ title: curTitle, body: cur.join("\n").trim(), symbol: curTitle });
  };
  for (const line of lines) {
    const m = line.match(/^(?:def|class)\s+([A-Za-z_][\w]*)/);
    if (m) {
      flush();
      curTitle = m[1];
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  flush();
  return chunks.filter((c) => c.body.length > 20);
}

export async function ingestSample(sampleDir) {
  const db = await openDb();
  const jobs = [
    { kind: "spec", dir: path.join(sampleDir, "specs"), cut: (t) => cutMarkdown(t) },
    { kind: "code", dir: path.join(sampleDir, "app"), cut: (t, n) => cutPython(t, n) },
    { kind: "test", dir: path.join(sampleDir, "tests"), cut: (t, n) => cutPython(t, n) },
    { kind: "task", dir: path.join(sampleDir, "tasks"), cut: (t) => cutMarkdown(t) },
  ];

  let written = 0;
  for (const job of jobs) {
    if (!fs.existsSync(job.dir)) continue;
    for (const file of fs.readdirSync(job.dir).sort()) {
      const full = path.join(job.dir, file);
      if (!fs.statSync(full).isFile()) continue;
      const rel = path.relative(sampleDir, full).replace(/\\/g, "/");
      const raw = fs.readFileSync(full, "utf8");
      const base = file.replace(/\.[^.]+$/, "");
      let index = 0;
      for (const chunk of job.cut(raw, base)) {
        // 同一文件的多段必须有区分度，否则会被 (path, symbol) 唯一键覆盖成一条
        if (!chunk.symbol) chunk.symbol = `#p${index}`;
        index += 1;
        // 标题拼进正文：单段正文常常看不出属于哪个文档，拼标题后检索命中更准
        const body = `${chunk.title}\n\n${chunk.body}`;
        await db.query(
          `INSERT INTO ctx_docs (kind, path, symbol, title, body, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body),
             content_hash=VALUES(content_hash), updated_at=CURRENT_TIMESTAMP`,
          [job.kind, rel, chunk.symbol || "", chunk.title, body, hash(body)],
        );
        written += 1;
      }
    }
  }
  const [rows] = await db.query(
    "SELECT kind, COUNT(*) AS n FROM ctx_docs GROUP BY kind ORDER BY kind",
  );
  return { written, stats: rows };
}
