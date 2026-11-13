# SDD 工程上下文模块（MiniMax × OceanBase）

面向规格驱动开发（SDD）的工程上下文模块：把**规格、代码、测试**三类资料存进 seekdb，按开发任务检索出**当前有效**的上下文，交给 **MiniMax** 完成一次真实代码修改，并把任务进展与验证结果写进 **PowerContext**，模块重启后继续使用。

对应赛题：**生态伙伴 2026 年数据库大赛题目：MiniMax —— 规有所依，面向软件持续演进的 SDD 上下文管理系统**（`minimax` 目录）。

---

## 1. 运行

```bash
npm install                                   # @oceanbase/seekdb-node + mysql2
python -m pip install -r requirements.txt     # pytest；PowerContext 见第 5 节

# ① 把 sample/ 下的规格、代码、测试导入 seekdb（首次会自动拉起本地 seekdb 并建表）
node src/cli.mjs import

# ② 只组装上下文，不调用模型（可先看检索质量）
node src/cli.mjs context

# ③ 完整流程：上下文 → MiniMax 改代码 → 修改前后测试对比 → 状态写 PowerContext
export MINIMAX_API_KEY=sk-cp-...              # 或写入 ../.secrets/minimax_key.txt
node src/cli.mjs dev

# ④ 重新启动后读取并使用已保存的任务状态
node src/cli.mjs state
```

`src/cli.mjs dev` 会输出结构化报告，并把证据落盘到 `evidence/`：

| 文件 | 内容 |
|---|---|
| `context-T-1042.json` | seekdb 检索出来的规格 / 代码 / 测试条目与命中分数 |
| `minimax-response-T-1042.md` | MiniMax 返回的完整修改与说明 |
| `minimax-calls.jsonl` | 每次模型调用：模型、端点、请求 id、token 用量、时延、prompt 摘要哈希 |
| `run-T-1042.json` | 修改前后测试退出码、作用文件、PowerContext 写入的 artifact |

## 2. 上下文模块的输入输出

**入口**：`node src/cli.mjs context`（CLI）或 `import { buildContext } from "./src/context.mjs"`（库调用）。

输入：任务描述文本（`sample/tasks/T-1042.md`）。
输出：JSON，四段内容一一对应赛题要求：

```json
{
  "specs":  [{"path": "specs/SPEC-pagination.md", "title": "...", "score": 7.14, "snippet": "..."}],
  "code":   [{"path": "app/tickets.py", "symbol": "list_tickets", "score": 3.87, "snippet": "..."}],
  "tests":  [{"path": "tests/test_tickets_task.py", "symbol": "test_filter_by_tag", "snippet": "..."}],
  "task":   {"id": "T-1042", "text": "..."}
}
```

已完成 / 待办 / 验证结果不写死在模块里，而是每次从 PowerContext 读回（`node src/cli.mjs state`），这样规格更新、任务中断、换会话都不会丢。

## 3. 技术分工

| 技术 | 在本项目里实际承担的作用 |
|---|---|
| **MiniMax**（`MiniMax-M3.1-Flash`，Anthropic 兼容通道 `api.minimaxi.com/anthropic`） | 拿到上下文后生成 `app/tickets.py` 的完整修改；每次调用的请求 id / token 用量 / 时延都记入 `evidence/minimax-calls.jsonl`，与提交的代码差异一一对应 |
| **seekdb**（`@oceanbase/seekdb-node` 本地实例 + MySQL 协议） | 存规格 / 代码 / 测试共 30 个切块；建 `ik` 中文全文索引；检索由 `MATCH ... AGAINST` 在库内完成，返回带分数的条目，检索结果直接构成上下文 |
| **PowerContext**（HTTP API，`127.0.0.1:8787`） | 用 `POST /v1/scopes` 建独立 scope，`POST /v1/memory/remember` 写任务状态（completed / todo / verification），`POST /v1/memory/entries/list` 读回；重启模块后 `state` 命令仍能取到上一次的进展 |

## 4. 验证样例（可直接复现）

`sample/` 是一个能跑、有测试的业务小工程：

```
sample/
  app/tickets.py            工单列表：状态/优先级筛选 + 分页（待修改的实现）
  specs/SPEC-pagination.md  分页规格：page<1、page_size>100 的归一化与越界语义
  specs/SPEC-filtering.md   筛选规格：新增 tag 维度，多维度 AND
  specs/SPEC-api-contract.md 接口契约：签名、返回结构、兼容性要求
  tasks/T-1042.md           本次任务：增加标签筛选 + 修正分页边界
  tests/test_tickets.py     回归测试（修改前后都必须通过）
  tests/test_tickets_task.py 目标测试（修改前失败、修改后通过）
```

复现步骤：

```bash
python -m pytest sample/tests/test_tickets_task.py -q   # 修改前：4 failed
python -m pytest sample/tests/test_tickets.py -q        # 修改前：4 passed
node src/cli.mjs dev                                    # 上下文 → MiniMax 修改 → 两次测试
python -m pytest sample/tests -q                        # 修改后：全部通过
```

重置方法：`git checkout -- sample/app/tickets.py && rm -f sample/app/tickets.py.orig`，再重跑 `node src/cli.mjs import`（幂等 upsert）。

## 5. PowerContext 服务

```bash
python -m pip install "powercontext[server,builtin,cli]"
python - <<'PY'
import sys
from powercontext.server.cli import app
sys.argv = ["pc-server", "run", "--host", "127.0.0.1", "--port", "8787", "--no-env-file"]
app()
PY
```

服务起在 `http://127.0.0.1:8787`，状态落在本地 SQLite，进程重启不丢。模块侧只依赖 HTTP API，不 import 任何 PowerContext Python 包。

## 6. 已知限制

- 代码切块按顶层 `def` / `class` 切，模块级常量不单独成块（本样例的 `TICKETS` 测试夹具因此在代码块里看不到）。
- 全文检索用 `ik` 分词；任务描述过于口语化且不含标识符时会退回 `LIKE` 兜底，召回不如向量检索细腻。
- MiniMax 输出按 `file=` 代码块解析，模型若改格式需要调整 `src/dev.mjs::extractFiles`。
- PowerContext 未配置推理模型，因此只用显式 `memory/remember` 通道，不依赖后台记忆抽取。
