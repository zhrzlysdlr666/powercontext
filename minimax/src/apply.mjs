// 手工通道：把模型（MiniMax Agent 网页 / 其它对话界面）给出的回复落盘、应用、跑测试、写状态。
// 与 dev.mjs 的区别只有一点——模型调用发生在外部，这里负责 **可核查地** 把结果接回流程：
//   1. 解析回复里的 ```python file=... 代码块（与 dev.mjs 同一套正则）；
//   2. 先把目标文件恢复成修改前快照，跑一次"修改前"测试（保证 before/after 可对比）；
//   3. 应用回复内容，跑"修改后"测试，落 diff；
//   4. 把进展与验证结果写入 PowerContext，并生成 run-<taskId>.json。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVIDENCE_DIR } from "./minimax.mjs";
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
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
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
  const abs = path.resolve(SAMPLE, rel.replace(/^sample[\\/]/, ""));
  if (!abs.startsWith(SAMPLE)) throw new Error(`非法路径: ${rel}`);
  return abs;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function gitDiff(relPath) {
  const r = spawnSync("git", ["diff", "--", relPath], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout || "" : "";
}

/**
 * @param {object} o
 * @param {string} o.taskId          任务编号，默认 T-1042
 * @param {string} o.responsePath    模型回复原文（.md / .txt）
 * @param {string} [o.provider]      记录用：模型/产品标识，例如 "MiniMax Agent (agent.minimax.cn)"
 * @param {string} [o.sessionUrl]    记录用：会话链接（评审可点开核对）
 * @param {string} [o.model]         记录用：模型名，例如 "MiniMax-M3.1-Flash"
 */
export async function applyResponse({
  taskId = "T-1042",
  responsePath,
  provider = "MiniMax Agent (agent.minimax.cn)",
  sessionUrl = "",
  model = "",
} = {}) {
  if (!responsePath) throw new Error("缺少回复文件路径：node src/cli.mjs apply <response.md>");
  const absResp = path.resolve(ROOT, responsePath);
  if (!fs.existsSync(absResp)) throw new Error(`回复文件不存在: ${absResp}`);
  const text = fs.readFileSync(absResp, "utf8");
  const files = extractFiles(text);
  if (!files.length) {
    throw new Error(
      '回复里没有找到 ```python file=... 代码块；请让模型按 "```python file=app/tickets.py" + 完整文件内容 输出',
    );
  }

  const startedAt = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // ① 恢复修改前快照：有 .orig 就从它恢复，没有就现场备份当前文件。
  //    这样无论重跑几次，"修改前测试"量的都是同一个基线。
  const backups = [];
  for (const f of files) {
    const abs = safeTarget(f.path);
    const bak = `${abs}.orig`;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, abs);
    } else if (fs.existsSync(abs)) {
      fs.copyFileSync(abs, bak);
    }
    backups.push({ rel: f.path, abs, bak });
  }

  const before = {
    target: runPytest(TARGET_TEST),
    regression: runPytest(REGRESSION_TEST),
  };

  // ② 应用回复
  const applied = [];
  for (const f of files) {
    const abs = safeTarget(f.path);
    fs.writeFileSync(abs, f.content);
    applied.push({ path: f.path, chars: f.content.length });
  }

  const after = {
    target: runPytest(TARGET_TEST),
    regression: runPytest(REGRESSION_TEST),
  };

  // ③ diff 证据
  const diffs = backups.map((b) => gitDiff(path.relative(ROOT, b.abs))).join("\n");
  if (diffs.trim()) {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `changes-${taskId}.diff`), diffs);
  }

  // ④ 状态落 PowerContext（服务没起时降级，不阻断取证）
  let scopeId = null;
  let artifact = null;
  let previousStateFound = false;
  let stateError = null;
  try {
    scopeId = await ensureScope();
    const prev = await loadState(scopeId, taskId);
    previousStateFound = Boolean(prev);
    artifact = await saveState(scopeId, taskId, {
      completed: [
        "导入规格/代码/测试到 seekdb 并建立 ik 全文索引",
        "按任务检索并组装上下文",
        ...(files.length ? [`由 ${provider} 生成 ${files.map((f) => f.path).join(", ")} 修改`] : []),
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
    });
  } catch (e) {
    stateError = e.message;
  }

  // ⑤ 模型侧记录（与 minimax-calls.jsonl 并列，标明来自网页 Agent 会话）
  const record = {
    at: startedAt,
    channel: "agent-session",
    provider,
    model,
    session_url: sessionUrl,
    response_file: path.relative(ROOT, absResp),
    response_sha256: sha256(text),
    response_chars: text.length,
    applied_files: applied,
    before: { target: before.target.code, regression: before.regression.code },
    after: { target: after.target.code, regression: after.regression.code },
  };
  fs.appendFileSync(
    path.join(EVIDENCE_DIR, "minimax-agent-calls.jsonl"),
    JSON.stringify(record) + "\n",
  );

  const report = {
    task_id: taskId,
    started_at: startedAt,
    channel: "agent-session",
    scope_id: scopeId,
    applied_files: applied,
    before: { target: before.target.code, regression: before.regression.code },
    after: { target: after.target.code, regression: after.regression.code },
    minimax: { provider, model, session_url: sessionUrl, response_file: record.response_file },
    powercontext: { scope_id: scopeId, artifact, error: stateError },
    previous_state_found: previousStateFound,
    diff_file: diffs.trim() ? `changes-${taskId}.diff` : null,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, `run-${taskId}.json`), JSON.stringify(report, null, 2));
  return report;
}
