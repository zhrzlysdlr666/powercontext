// 上下文组装：给定任务文本，从 seekdb 检索规格 / 代码 / 测试三类资料，组装成可交给 MiniMax 的上下文。
import { openDb } from "./db.mjs";

const TOP_K = { spec: 3, code: 3, test: 3 };

// 任务文本里出现的标识符（例如 list_tickets）单独提出来，用于符号级命中
function identifiers(text) {
  return Array.from(new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) || []))).slice(0, 12);
}

async function searchKind(db, kind, query, limit) {
  const [rows] = await db.query(
    `SELECT path, symbol, title, body, MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
       FROM ctx_docs
      WHERE kind = ? AND MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE)
      ORDER BY score DESC
      LIMIT ?`,
    [query, kind, query, limit],
  );
  return rows;
}

// 关键词检索兜底：全文检索没命中时（例如任务描述过于口语化），用标识符做 LIKE 匹配
async function searchLike(db, kind, terms, limit) {
  if (!terms.length) return [];
  const clause = terms.map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ");
  const params = [kind];
  for (const t of terms) params.push(`%${t}%`, `%${t}%`);
  params.push(limit);
  const [rows] = await db.query(
    `SELECT path, symbol, title, body, 0 AS score FROM ctx_docs
      WHERE kind = ? AND (${clause}) LIMIT ?`,
    params,
  );
  return rows;
}

function trim(body, n = 700) {
  const clean = String(body || "").replace(/\s+\n/g, "\n").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

export async function buildContext(taskText, taskId = "") {
  const db = await openDb();
  const query = taskText.slice(0, 240);
  const ids = identifiers(taskText);
  const out = { task: { id: taskId, text: taskText }, specs: [], code: [], tests: [] };

  for (const kind of ["spec", "code", "test"]) {
    let rows = await searchKind(db, kind, query, TOP_K[kind]);
    if (!rows.length) rows = await searchLike(db, kind, ids, TOP_K[kind]);
    // 标识符精确命中的条目提到最前面（任务里点名了某个函数时，这就是要改的地方）
    rows.sort((a, b) => {
      const hit = (r) => (ids.some((i) => r.title.includes(i) || r.symbol === i) ? 1 : 0);
      return hit(b) - hit(a) || (b.score || 0) - (a.score || 0);
    });
    const key = kind === "spec" ? "specs" : kind === "code" ? "code" : "tests";
    out[key] = rows.map((r) => ({
      path: r.path,
      title: r.title,
      symbol: r.symbol || null,
      score: Number(Number(r.score || 0).toFixed(4)),
      snippet: trim(r.body),
    }));
  }
  return out;
}

export function contextToPrompt(ctx) {
  const part = (label, rows) =>
    rows.length
      ? `### ${label}\n` + rows.map((r, i) => `[${label}${i + 1}] ${r.path}${r.symbol ? ` :: ${r.symbol}` : ""}\n${r.snippet}`).join("\n\n")
      : `### ${label}\n(无)`;
  return [part("适用规格", ctx.specs), part("相关代码", ctx.code), part("验证测试", ctx.tests)].join("\n\n");
}
