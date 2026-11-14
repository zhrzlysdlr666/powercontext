// StudyLens · seekdb 生命周期与 SQL 连接
// 所有学习资料切片都存在本地 seekdb 里，检索（含中文分词）由 seekdb 的 MATCH ... AGAINST 完成。
//
// 注意：seekdb 依赖是「可选能力」，只在重建索引/直连数据库时才需要。
// 主流程（python main.py / node main.mjs / 静态页面）零依赖即可运行，
// 所以这里用动态 import：缺依赖时给出可读的提示，而不是让整个进程崩在模块加载阶段。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let seekdbLib = null;
let mysqlLib = null;

export const DEP_MISSING_HINT =
  "未安装 seekdb 可选依赖。主流程不需要它（python main.py / node main.mjs 即可自检与起服务）；" +
  "如需重建索引或直连 seekdb，执行：cd qoder && npm install @oceanbase/seekdb-node mysql2";

async function loadSeekdb() {
  if (seekdbLib && mysqlLib) return { seekdb: seekdbLib, mysql: mysqlLib };
  try {
    const s = await import("@oceanbase/seekdb-node");
    const m = await import("mysql2/promise");
    seekdbLib = s.seekdb || s.default || s;
    mysqlLib = m.default || m;
  } catch (e) {
    const err = new Error(DEP_MISSING_HINT);
    err.code = "SEEKDB_DEPS_MISSING";
    err.cause = e;
    throw err;
  }
  return { seekdb: seekdbLib, mysql: mysqlLib };
}

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DB_DIR = process.env.STUDYLENS_DB || path.join(ROOT, "data", "seekdb");

let handle = null;
let pool = null;

export async function openDb() {
  if (pool) return pool;
  const { seekdb, mysql } = await loadSeekdb();
  fs.mkdirSync(path.dirname(DB_DIR), { recursive: true });
  handle = await seekdb.open(DB_DIR, { parameters: { memory_budget: "1G" } });
  const ep = handle.connectionOptions();
  if (ep.transport !== "tcp") throw new Error(`unsupported transport: ${ep.transport}`);
  pool = mysql.createPool({
    host: ep.host,
    port: ep.port,
    user: ep.user,
    password: "",
    database: "test",
    connectionLimit: 4,
    charset: "utf8mb4",
  });
  await ensureSchema(pool);
  return pool;
}

export async function closeDb() {
  if (pool) await pool.end();
  if (handle) handle.close();
  pool = null;
  handle = null;
}

async function ensureSchema(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS study_docs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      doc VARCHAR(255) NOT NULL,
      topic VARCHAR(64) NOT NULL,
      heading VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_chunk (doc, heading),
      KEY k_topic (topic),
      FULLTEXT INDEX ft_body (body) WITH PARSER ik
    )
  `);
}

export async function stats() {
  const db = await openDb();
  const [rows] = await db.query(
    "SELECT topic, COUNT(*) AS n FROM study_docs GROUP BY topic ORDER BY topic",
  );
  return rows;
}
