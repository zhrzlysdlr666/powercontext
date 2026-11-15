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
// Linux 上一般只有 python3，Windows 上才是 python；PYTHON 环境变量可覆盖
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const TARGET_TEST = "sample/tests/test_tickets_task.py";
const REGRESSION_TEST = "sample/tests/test_tickets.py";

export function runPytest(relPath) {
  const r = spawnSync(PY, ["-m", "pytest", relPath, "-q", "--no-header"], {
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

function gitDiff(relPath, baselineAbs) {
  const r = spawnSync("git", ["diff", "--", relPath], { cwd: ROOT, encoding: "utf8" });
  if (r.status === 0 && (r.stdout || "").trim()) return r.stdout;
  // 修改已经随提交进入 HEAD 时，工作区与 HEAD 相同，`git diff` 为空；
  // 这时直接用「修改前快照 → 应用后文件」生成无索引 diff，保证补丁永远可核对。
  if (baselineAbs && fs.existsSync(baselineAbs)) {
    const r2 = spawnSync(
      "git",
      ["diff", "--no-index", "--", baselineAbs, path.resolve(ROOT, relPath)],
      { cwd: ROOT, encoding: "utf8" },
    );
    // 把绝对路径改写成仓库内相对路径，评审可以把这段补丁直接 `git apply` 到修改前文件
    const rel = `minimax/${relPath.replace(/\\/g, "/")}`;
    const lines = (r2.stdout || "").split("\n");
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
      if (lines[i].startsWith("diff --git ")) lines[i] = `diff --git a/${rel} b/${rel}`;
      else if (lines[i].startsWith("--- ")) lines[i] = `--- a/${rel}`;
      else if (lines[i].startsWith("+++ ")) lines[i] = `+++ b/${rel}`;
      else if (lines[i].startsWith("index ")) continue;
      else break;
    }
    return lines.join("\n");
  }
  return "";
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

  // ① 恢复修改前快照。基线来源按优先级：
  //    a) 上一次运行留下的 <file>.orig；
  //    b) 仓库随证据一起保存的 evidence/before-<basename>（评审从干净 checkout 开始时走这条）；
  //    c) 都没有，才把当前文件当基线（会在报告里标 baseline_source=working-tree，提醒不可信）。
  //    这样无论重跑几次、无论有没有 .orig，"修改前测试"量的都是同一个基线。
  const backups = [];
  const baselineSources = [];
  for (const f of files) {
    const abs = safeTarget(f.path);
    const bak = `${abs}.orig`;
    const shipped = path.join(EVIDENCE_DIR, `before-${path.basename(abs)}`);
    let source;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, abs);
      source = "orig";
    } else if (fs.existsSync(shipped)) {
      fs.copyFileSync(shipped, abs);
      fs.copyFileSync(shipped, bak); // 归一化成 .orig，下次直接命中
      source = "evidence";
    } else if (fs.existsSync(abs)) {
      fs.copyFileSync(abs, bak);
      source = "working-tree";
    } else {
      source = "missing";
    }
    backups.push({ rel: f.path, abs, bak, source });
    baselineSources.push({ path: f.path, source });
  }
  if (baselineSources.some((b) => b.source !== "orig" && b.source !== "evidence")) {
    console.warn(
      `[warn] 没有找到修改前快照，已把当前工作区文件当作基线：${baselineSources
        .filter((b) => b.source !== "orig" && b.source !== "evidence")
        .map((b) => b.path)
        .join(", ")}；该次 before 结果不可作为"修改前失败"的证据。`,
    );
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
  const diffs = backups.map((b) => gitDiff(path.relative(ROOT, b.abs), b.bak)).join("\n");
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
    baseline_source: baselineSources,
    before: { target: before.target.code, regression: before.regression.code },
    after: { target: after.target.code, regression: after.regression.code },
    before_detail: { target: before.target.tail, regression: before.regression.tail },
    after_detail: { target: after.target.tail, regression: after.regression.tail },
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
    baseline_source: baselineSources,
    before: { target: before.target.code, regression: before.regression.code },
    after: { target: after.target.code, regression: after.regression.code },
    before_detail: { target: before.target.tail, regression: before.regression.tail },
    after_detail: { target: after.target.tail, regression: after.regression.tail },
    minimax: { provider, model, session_url: sessionUrl, response_file: record.response_file },
    powercontext: { scope_id: scopeId, artifact, error: stateError },
    previous_state_found: previousStateFound,
    diff_file: diffs.trim() ? `changes-${taskId}.diff` : null,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, `run-${taskId}.json`), JSON.stringify(report, null, 2));
  return report;
}
