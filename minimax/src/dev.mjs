// 一次完整的开发任务：上下文组装 → MiniMax 改代码 → 修改前后测试对比 → 状态落 PowerContext。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildContext, contextToPrompt } from "./context.mjs";
import { askMiniMax, EVIDENCE_DIR } from "./minimax.mjs";
import { ensureScope, saveState, loadState } from "./state.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAMPLE = path.join(ROOT, "sample");
const TARGET_TEST = "sample/tests/test_tickets_task.py";
const REGRESSION_TEST = "sample/tests/test_tickets.py";

export function runPytest(relPath) {
  const r = spawnSync("python", ["-m", "pytest", relPath, "-q", "--no-header"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const tail = out.split(/\r?\n/).slice(-3).join(" | ");
  return { code: r.status, tail, out };
}

function extractFiles(text) {
  const files = [];
  const re = /```(?:python|py)[^\n]*?file=([^\s`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) files.push({ path: m[1].trim(), content: m[2] });
  return files;
}

function safeTarget(rel) {
  const abs = path.resolve(SAMPLE, rel.replace(/^sample\//, ""));
  if (!abs.startsWith(SAMPLE)) throw new Error(`非法路径: ${rel}`);
  return abs;
}

export async function runDev({ taskId = "T-1042", taskText, apply = true } = {}) {
  const startedAt = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const scopeId = await ensureScope();
  const prev = await loadState(scopeId, taskId);

  const ctx = await buildContext(taskText, taskId);
  fs.writeFileSync(path.join(EVIDENCE_DIR, `context-${taskId}.json`), JSON.stringify(ctx, null, 2));

  const before = {
    target: runPytest(TARGET_TEST),
    regression: runPytest(REGRESSION_TEST),
  };

  const system = [
    "你是 MiniMax 驱动的开发助手，在规格驱动开发（SDD）流程里完成一次局部代码修改。",
    "只依据给出的规格、代码和测试做修改，不要引入未在规格中声明的行为。",
    "输出格式：每个需要修改的文件输出一个代码块，代码块语言标记后加 file=相对路径，例如：",
    "```python file=app/tickets.py",
    "...完整文件内容...",
    "```",
    "不要输出解释性段落之外的其它格式。",
  ].join("\n");

  const prompt = [
    `## 任务`,
    taskText,
    "",
    `## 已保存的任务状态（来自 PowerContext，可能为空）`,
    prev ? JSON.stringify({ completed: prev.completed, todo: prev.todo, verification: prev.verification }) : "（无，首次执行）",
    "",
    "## 检索到的工程上下文（来自 seekdb）",
    contextToPrompt(ctx),
    "",
    "## 要求",
    "1. 只修改 app/tickets.py 一个文件，输出完整文件内容；",
    "2. 逐条满足规格中的归一化与筛选规则；",
    "3. 保持返回结构 {items, page, page_size, total} 不变。",
  ].join("\n");

  const answer = await askMiniMax({ system, prompt, maxTokens: 3072, tag: `dev:${taskId}` });
  fs.writeFileSync(path.join(EVIDENCE_DIR, `minimax-response-${taskId}.md`), answer.text);

  const files = extractFiles(answer.text);
  const applied = [];
  for (const f of files) {
    const abs = safeTarget(f.path);
    if (apply) {
      const bak = `${abs}.orig`;
      if (!fs.existsSync(bak)) fs.copyFileSync(abs, bak);
      fs.writeFileSync(abs, f.content);
    }
    applied.push({ path: f.path, chars: f.content.length });
  }

  const after = {
    target: runPytest(TARGET_TEST),
    regression: runPytest(REGRESSION_TEST),
  };

  const state = {
    completed: [
      "导入规格/代码/测试到 seekdb 并建立 ik 全文索引",
      "按任务检索并组装上下文",
      ...(files.length ? ["由 MiniMax 生成 app/tickets.py 修改"] : []),
      ...(after.target.code === 0 ? ["目标测试全部通过"] : []),
      ...(after.regression.code === 0 ? ["回归测试全部通过"] : []),
    ],
    todo:
      after.target.code === 0 && after.regression.code === 0
        ? []
        : ["根据失败用例继续调整实现", "重新运行目标与回归测试"],
    verification: [
      `修改前 目标测试 exit=${before.target.code}：${before.target.tail}`,
      `修改前 回归测试 exit=${before.regression.code}：${before.regression.tail}`,
      `修改后 目标测试 exit=${after.target.code}：${after.target.tail}`,
      `修改后 回归测试 exit=${after.regression.code}：${after.regression.tail}`,
    ],
  };
  const artifact = await saveState(scopeId, taskId, state);

  const report = {
    task_id: taskId,
    started_at: startedAt,
    scope_id: scopeId,
    context_sources: {
      specs: ctx.specs.map((s) => s.path),
      code: ctx.code.map((s) => `${s.path}::${s.symbol}`),
      tests: ctx.tests.map((s) => s.path),
    },
    applied_files: applied,
    before: { target: before.target.code, regression: before.regression.code },
    after: { target: after.target.code, regression: after.regression.code },
    minimax: { usage: answer.usage, request_id: answer.requestId },
    powercontext: { scope_id: scopeId, artifact },
    previous_state_found: Boolean(prev),
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, `run-${taskId}.json`), JSON.stringify(report, null, 2));
  return report;
}
