#!/usr/bin/env node
// 上下文模块入口：import / context / dev / state / restore
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingestSample } from "./ingest.mjs";
import { buildContext } from "./context.mjs";
import { runDev } from "./dev.mjs";
import { ensureScope, loadState } from "./state.mjs";
import { closeDb } from "./db.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAMPLE = path.join(ROOT, "sample");
const TASK_FILE = path.join(SAMPLE, "tasks", "T-1042.md");

const cmd = process.argv[2] || "help";
const taskText = () => fs.readFileSync(TASK_FILE, "utf8");

async function main() {
  if (cmd === "import") {
    const out = await ingestSample(SAMPLE);
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "context") {
    const ctx = await buildContext(taskText(), "T-1042");
    console.log(JSON.stringify(ctx, null, 2));
  } else if (cmd === "dev") {
    const apply = !process.argv.includes("--dry-run");
    const report = await runDev({ taskId: "T-1042", taskText: taskText(), apply });
    console.log(JSON.stringify(report, null, 2));
  } else if (cmd === "state") {
    const scopeId = await ensureScope();
    const state = await loadState(scopeId, "T-1042");
    console.log(JSON.stringify({ scope_id: scopeId, state }, null, 2));
  } else {
    console.log(`用法:
  node src/cli.mjs import           把 sample/ 下的规格、代码、测试写入 seekdb
  node src/cli.mjs context          只组装上下文（不调用模型）
  node src/cli.mjs dev [--dry-run]  完整流程：上下文 → MiniMax 修改 → 测试对比 → 状态落库
  node src/cli.mjs state            读取 PowerContext 中保存的任务状态`);
  }
}

main()
  .catch((e) => {
    console.error("ERROR", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (cmd !== "dev") await closeDb();
  });
