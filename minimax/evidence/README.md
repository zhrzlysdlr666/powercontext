# T-1042 开发记录与证据

本目录是「用 MiniMax 参与代码修改」的完整留痕，对应任务 `sample/tasks/T-1042.md`（工单列表增加标签筛选并修正分页边界）。
所有文件都由仓库内的命令生成，可原地复现。

## 1. 会话信息

| 项 | 值 |
|---|---|
| 产品 | MiniMax Code 网页端（`agent.minimax.cn`，MiniMax 官方产品） |
| 模型 | `MiniMax-M3.1-Flash`（页面模型选择器显示 `M3.1-Flash`） |
| 会话链接 | https://agent.minimax.cn/mavis?id=463620122608782 |
| 生成时间 | 2026-11-15 19:16–19:18（页面计时「共执行 1 分 23 秒」） |
| 输入 | `evidence/prompt-T-1042.md`（由 seekdb 检索结果拼成，未让模型自行读取仓库） |
| 输出 | `evidence/minimax-response-T-1042.md`（回复原文，含说明与代码块） |

会话截图（同一会话的三张连续性证据，均为本次 19:16–19:18 会话）：

- `screenshots/01-prompt-sent.png` — 提示词已发送（气泡折叠显示，点开可见全文）
- `screenshots/02-reply-and-code.png` — 回复正文的「验证情况」段落与 python 代码块开头
- `screenshots/03-code-block.png` — 代码块、交付物清单（`tickets.py`）与页面时间戳 19:17

## 2. 上下文来源（seekdb 实际参与）

`node src/cli.mjs import` 把 `sample/` 下的规格、代码、测试写入 seekdb（嵌入式 `@oceanbase/seekdb-node`），建立 ik 全文索引；
`node src/cli.mjs context` / `prompt` 用 `MATCH ... AGAINST` 检索后组装上下文。

- 入库统计：`spec 12 / test 9 / task 4 / code 4`，共 29 个切片（`apply` 生成的 `.orig` 快照会被跳过并在下次 `import` 时清理，不参与检索）
- 检索结果：`evidence/context-T-1042.json`（含每条命中的 path / symbol / score / snippet）
- 命中示例：`SPEC-pagination#p0` 6.3248、`SPEC-filtering#p0` 5.4222、`test_tag_filter_combines_with_status` 5.8498、`test_filter_by_tag` 4.3330、`test_page_zero_normalized_to_first_page` 4.1279、`app/tickets.py:list_tickets` 3.6808
- 规格更新后是否跟着变：见 `evidence/spec-update-check.md`（改一行规格 → 重新 `import` → `context` 出现新文本 → 还原后消失）

## 3. 验证结果（修改前 / 修改后）

`node src/cli.mjs apply evidence/minimax-response-T-1042.md` 会先把 `sample/app/tickets.py` 恢复成修改前快照，
跑一次目标测试与回归测试，再应用模型改动、重跑同样的两组测试，因此「前失败 / 后通过」可重复核对。

基线按 `sample/app/tickets.py.orig` → 本目录的 `before-tickets.py` 依次回落，报告里的 `baseline_source`
会写明这一轮用的是哪一个（干净 checkout 上应为 `evidence`），因此 before 那一轮量的确实是修改前代码。

| 阶段 | 目标测试 `tests/test_tickets_task.py` | 回归测试 `tests/test_tickets.py` |
|---|---|---|
| 修改前 | `exit=1`，`4 failed, 1 passed` | `exit=0`，`4 passed` |
| 修改后 | `exit=0`，`5 passed` | `exit=0`，`4 passed` |

原始 pytest 尾部输出见 `run-T-1042.json` 的 `before` / `after`（退出码）与 `before_detail` / `after_detail`
（pytest 尾部原文）；PowerContext 侧的状态读回见 `state-T-1042.json`（`node src/cli.mjs state` 的原始输出，
包含 completed / todo / verification 三段）。`after-tickets.py` 是修改后文件的快照，配合 `before-tickets.py`
可以直接逐行对比，不需要先跑一遍流程。


## 4. 代码差异

`evidence/changes-T-1042.diff` 是 `git diff -- minimax/sample/app/tickets.py` 的输出，与
`minimax-response-T-1042.md` 里的代码块逐字一致（`minimax-agent-calls.jsonl` 里记录了回复文件的 sha256，可用于校验未被事后修改）。

只改 `app/tickets.py` 一个文件；两份测试文件的断言未做任何修改（模型在回复里另附的两份测试文件未被采用，`apply` 只接受 `file=app/tickets.py` 这一个块）。

## 5. 状态落库（PowerContext）

| 项 | 值 |
|---|---|
| Scope | `scp_14b3m2p4jcggwbwcmkvyxvw1w8`（标题：SDD 上下文模块 T-1042） |
| Artifact | `atomic-memory / art_30ab1a36dc7b4d459908352427d0ad66`（rev 1） |
| 读回 | `node src/cli.mjs state` 可读回 completed / todo / verification（原文见 `state-T-1042.json`，`scope_id` 与上表一致） |
| 重启后读回 | 已验证：服务端进程重启后再次 `apply`，`run-T-1042.json` 的 `previous_state_found: true`，`scope_id` 仍是 `scp_14b3…w1w8` |

复现顺序就是"从空状态开始"的顺序（PowerContext 用全新 SQLite 库）：

1. 首次 `apply`：库里只有 `Default` scope，模块新建 `SDD 上下文模块 T-1042` 并写入 T-1042 的状态，
   报告里 `previous_state_found: false`（此时确实没有上次状态）。
2. `Ctrl-C` 停掉 `powercontext server run`，再用同一条命令重启（SQLite 库不动）。
3. 再次 `apply`：`ensureScope` 按标题找回同一个 scope，`loadState` 读到第 1 步写入的记录，
   报告里 `previous_state_found: true`；`state` 读回的 completed / todo / verification 与写入内容一致。
   这两份就是本目录下的 `run-T-1042.json` 与 `state-T-1042.json`。

> 每次 `saveState` 都会生成新的 artifact（`revision` 从 1 计），所以 artifact id 以 `state-T-1042.json`
> 里的为准；重跑一次 `apply` 后这个 id 会变，属正常现象。

## 6. 复现命令

```bash
npm install
node src/cli.mjs import                       # 写入 seekdb 并建 ik 索引
node src/cli.mjs prompt                       # → evidence/prompt-T-1042.md
# 把 prompt 整段贴进 MiniMax Agent，回复另存为 evidence/minimax-response-T-1042.md

# 恢复"修改前"基线（任务开始时的 app/tickets.py，本仓库随证据一起保存）
cp evidence/before-tickets.py sample/app/tickets.py && rm -f sample/app/tickets.py.orig

node src/cli.mjs apply evidence/minimax-response-T-1042.md \
  --provider="MiniMax Code 网页端 (agent.minimax.cn)" \
  --model="MiniMax-M3.1-Flash" \
  --session="https://agent.minimax.cn/mavis?id=463620122608782"
node src/cli.mjs state                        # 读回 PowerContext 中的任务状态

# 状态复用：停掉 powercontext server 再启动，然后把上面两步再跑一遍，
# apply 报告里的 previous_state_found 会变成 true，state 读回同一条记录
```

`apply` 恢复基线的顺序是 `sample/app/tickets.py.orig` → 本目录 `before-tickets.py`，所以即使从干净
checkout（没有 `.orig`）直接跑 apply，before 那一轮量的仍是修改前代码；报告里的 `baseline_source`
会写明实际用了哪一个。只有两者都不存在时才会退化成"把当前文件当基线"，并打印 `[warn]` 提示。

`apply` 与 `state` 需要 `POWECONTEXT_URL` 指向已启动的 PowerContext Server（默认 `http://127.0.0.1:8787`）；
`import` / `context` / `prompt` 只需要 `npm install` 装好的嵌入式 seekdb。
