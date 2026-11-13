// seekdb 生命周期 + SQL 连接。所有工程资料都存在 seekdb 里，检索也由 seekdb 完成。
import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DB_DIR = process.env.SEEPDB_DIR || path.join(ROOT, "data", "seekdb");

let handle = null;
let pool = null;

export async function openDb() {
  if (pool) return pool;
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
    CREATE TABLE IF NOT EXISTS ctx_docs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      kind VARCHAR(16) NOT NULL,
      path VARCHAR(255) NOT NULL,
      symbol VARCHAR(128) NOT NULL DEFAULT '',
      title VARCHAR(255) NOT NULL,
      body MEDIUMTEXT NOT NULL,
      content_hash CHAR(64) NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_doc (path, symbol),
      KEY k_kind (kind),
      FULLTEXT INDEX ft_body (body) WITH PARSER ik
    )
  `);
  // 任务状态同时落一份在 seekdb（PowerContext 是主存储，这里是可审计的镜像）
  await p.query(`
    CREATE TABLE IF NOT EXISTS ctx_task_state (
      task_id VARCHAR(64) PRIMARY KEY,
      revision INT NOT NULL,
      payload JSON NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}
