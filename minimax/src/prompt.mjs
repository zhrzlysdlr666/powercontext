// 生成可直接粘贴到 MiniMax Agent（网页 / Agent 应用）的 prompt。
// 用途：当无法直连 API（没有 API Key、或额度只在 Agent 侧）时，把任务、规格、代码、测试的
// **完整原文**拼成一段提示词，交给 MiniMax 完成代码修改，再用 `cli.mjs apply` 把回复落盘、
// 跑测试、写状态。输出格式与 dev.mjs 的 extractFiles() 完全一致，两条通道可互相替代。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SAMPLE = path.join(ROOT, "sample");

const FENCE = "````";

function readSample(rel) {
  const abs = path.resolve(SAMPLE, String(rel).replace(/^sample[\\/]/, ""));
  if (!abs.startsWith(SAMPLE)) throw new Error(`非法路径: ${rel}`);
  if (!fs.existsSync(abs)) return `（文件不存在：${rel}）`;
  return fs.readFileSync(abs, "utf8").trimEnd();
}

function lang(rel) {
  if (rel.endsWith(".py")) return "python";
  if (rel.endsWith(".md")) return "markdown";
  if (rel.endsWith(".json")) return "json";
  return "text";
}

function block(title, rows, note) {
  if (!rows.length) return `### ${title}\n（无）`;
  const body = rows
    .map((p) => `${FENCE}${lang(p)} title=${p}\n${readSample(p)}\n${FENCE}`)
    .join("\n\n");
  return `### ${title}${note ? `（${note}）` : ""}\n\n${body}`;
}

/**
 * @param {object} o
 * @param {string} o.taskId
 * @param {string} o.taskText        任务描述原文
 * @param {object|null} o.prev       上次保存的任务状态（PowerContext），可为空
 * @param {{specs:string[],code:string[],tests:string[]}} o.sources 参与上下文的文件相对路径
 */
export function buildPrompt({ taskId, taskText, prev, sources }) {
  const names = [...sources.code, ...sources.tests];
  const outFormat = [
    "每个需要修改的文件输出**一个**代码块，语言标记后面紧跟 `file=` 和相对路径，块内是**修改后的完整文件内容**（用三个反引号，不要用四个）：",
    "",
    `${FENCE}text`,
    "```python file=app/tickets.py",
    "# ……这里是修改后的完整文件，不要省略任何原有函数……",
    "```",
    FENCE,
    "",
    "除此之外不要输出其它格式的代码块；不要用 diff、不要只给片段、不要改测试文件。",
  ].join("\n");

  return [
    "你是 MiniMax 驱动的开发助手，在规格驱动开发（SDD）流程里完成一次局部代码修改。",
    "只依据下面给出的规格、代码和测试做修改，不要引入未在规格中声明的行为。",
    "测试文件只读，不得修改断言或新增依赖。",
    "",
    `## 任务 ${taskId}`,
    "",
    String(taskText || "").trim(),
    "",
    "## 已保存的任务状态（来自 PowerContext，可能为空）",
    "",
    prev
      ? "```json\n" +
        JSON.stringify(
          { completed: prev.completed, todo: prev.todo, verification: prev.verification },
          null,
          2,
        ) +
        "\n```"
      : "（无，首次执行）",
    "",
    block("适用规格", sources.specs),
    "",
    block("需要修改的代码", sources.code),
    "",
    block("验证测试", sources.tests, "只读，不得修改"),
    "",
    "## 输出格式（必须严格遵守，否则无法自动落盘）",
    "",
    outFormat,
    "",
    "## 具体要求",
    "",
    `1. 只修改 ${names.length ? names[0] : "被任务点名的文件"}，输出完整文件内容；`,
    "2. 逐条满足规格中的归一化与筛选规则，参数默认值与原实现保持一致；",
    "3. 保持返回结构 {items, page, page_size, total} 不变；",
    "4. 代码块之前可以用一小段文字说明你改了哪几条规格，但不要贴整段代码之外的大段解释。",
  ].join("\n");
}

/** 静态来源：不依赖 seekdb，直接取 sample/ 下全部规格、代码、测试（离线兜底）。 */
export function staticSources() {
  const list = (rel) => {
    const dir = path.join(SAMPLE, rel);
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => /\.(md|py)$/.test(f))
          .sort()
          .map((f) => `${rel}/${f}`)
      : [];
  };
  return { specs: list("specs"), code: list("app"), tests: list("tests") };
}
