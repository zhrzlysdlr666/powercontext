#!/usr/bin/env node
// 上下文模块入口：import / context / prompt / dev / apply / state
// 依赖（@oceanbase/seekdb-node、mysql2）按需动态加载：没跑 npm install 的机器上，
// prompt / apply 这两条不碰数据库的通道仍然可用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAMPLE = path.join(ROOT, "sample");
const TASK_FILE = path.join(SAMPLE, "tasks", "T-1042.md");

const argv = process.argv.slice(2);
const cmd = argv[0] || "help";
const flag = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const taskText = () => fs.readFileSync(TASK_FILE, "utf8");

const load = async (mod) => import(`./${mod}.mjs`);
let dbTouched = false;

// 上下文来源：优先用 seekdb 检索结果（体现"检索结果构成上下文"），
// seekdb/依赖不可用时退回 sample/ 全量（保证 prompt 命令在任何机器上都能出东西）。
async function sourcesFromContext() {
  const { buildPrompt, staticSources } = await load("prompt");
  try {
    dbTouched = true;
    const { buildContext } = await load("context");
    const ctx = await buildContext(taskText(), "T-1042");
    const pick = (rows) => rows.map((r) => r.path);
    return {
      mode: "seekdb",
      prev: null,
      sources: { specs: pick(ctx.specs), code: pick(ctx.code), tests: pick(ctx.tests) },
      ctx,
    };
  } catch (e) {
    console.error(`[warn] seekdb 不可用（${e.message}），退回 sample/ 全量来源`);
    return { mode: "static", prev: null, sources: staticSources(), ctx: null };
  }
}

async function main() {
  if (cmd === "import") {
    const { ingestSample } = await load("ingest");
    const out = await ingestSample(SAMPLE);
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === "context") {
    const { buildContext } = await load("context");
    const ctx = await buildContext(taskText(), "T-1042");
    console.log(JSON.stringify(ctx, null, 2));
  } else if (cmd === "prompt") {
    const { buildPrompt } = await load("prompt");
    const { EVIDENCE_DIR } = await load("minimax");
    const { mode, sources, prev } = await sourcesFromContext();
    const prompt = buildPrompt({ taskId: "T-1042", taskText: taskText(), prev, sources });
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const outFile = path.join(EVIDENCE_DIR, "prompt-T-1042.md");
    fs.writeFileSync(outFile, prompt);
    console.log(`来源模式: ${mode}`);
    console.log(`规格 ${sources.specs.length} / 代码 ${sources.code.length} / 测试 ${sources.tests.length}`);
    console.log(`已写入: ${path.relative(ROOT, outFile)}（${prompt.length} 字符）`);
    console.log("把该文件整段贴给 MiniMax Agent，把回复存成 evidence/minimax-response-T-1042.md，再执行 apply。");
  } else if (cmd === "dev") {
    const { runDev } = await load("dev");
    const apply = !argv.includes("--dry-run");
    const report = await runDev({ taskId: "T-1042", taskText: taskText(), apply });
    console.log(JSON.stringify(report, null, 2));
  } else if (cmd === "apply") {
    const { applyResponse } = await load("apply");
    const report = await applyResponse({
      taskId: "T-1042",
      responsePath: argv[1],
      provider: flag("provider", "MiniMax Agent (agent.minimax.cn)"),
      model: flag("model", "MiniMax-M3.1-Flash"),
      sessionUrl: flag("session", ""),
    });
    console.log(JSON.stringify(report, null, 2));
  } else if (cmd === "state") {
    const { ensureScope, loadState } = await load("state");
    const scopeId = await ensureScope();
    const state = await loadState(scopeId, "T-1042");
    console.log(JSON.stringify({ scope_id: scopeId, state }, null, 2));
  } else {
    console.log(`用法:
  node src/cli.mjs import                把 sample/ 下的规格、代码、测试写入 seekdb
  node src/cli.mjs context               只组装上下文（不调用模型）
  node src/cli.mjs prompt                生成可粘贴到 MiniMax Agent 的 prompt → evidence/prompt-T-1042.md
  node src/cli.mjs dev [--dry-run]       直连 API 的完整流程：上下文 → MiniMax 修改 → 测试对比 → 状态落库
  node src/cli.mjs apply <response.md>   手工通道：解析模型回复 → 应用 → 修改前后测试对比 → 状态落库
                                         [--provider=] [--model=] [--session=会话链接]
  node src/cli.mjs state                 读取 PowerContext 中保存的任务状态`);
  }
}

main()
  .catch((e) => {
    console.error("ERROR", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dbTouched) {
      try {
        const { closeDb } = await load("db");
        await closeDb();
      } catch {
        /* 没开过库时忽略 */
      }
    }
  });
