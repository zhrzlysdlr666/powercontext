# T-1042 开发记录与证据

本目录是「用 MiniMax 参与代码修改」的完整留痕，对应任务 `sample/tasks/T-1042.md`（工单列表增加标签筛选并修正分页边界）。
所有文件都由仓库内的命令生成，可原地复现。

## 1. 会话信息

| 项 | 值 |
|---|---|
| 产品 | MiniMax Code 网页端（`agent.minimax.cn`，MiniMax 官方产品） |
| 模型 | `MiniMax-M3.1-Flash`（页面模型选择器显示 `M3.1-Flash`） |
| 会话链接 | https://agent.minimax.cn/mavis?id=463523103461753 |
| 生成时间 | 2026-11-15 13:31–13:33（页面计时「共执行 1 分 35 秒」） |
| 输入 | `evidence/prompt-T-1042.md`（由 seekdb 检索结果拼成，未让模型自行读取仓库） |
| 输出 | `evidence/minimax-response-T-1042.md`（回复原文，含说明与代码块） |

会话截图（同一会话的三张连续性证据）：

- `screenshots/01-prompt-sent.png` — 提示词发送后，页面进入「汇总中…」
- `screenshots/02-reply-and-code.png` — 回复正文、python 代码块、交付物清单（tickets.py / test_tickets_task.py / test_tickets.py）、页面时间戳 13:33
- `screenshots/03-code-block.png` — 代码块单独截屏，可逐行核对

## 2. 上下文来源（seekdb 实际参与）

`node src/cli.mjs import` 把 `sample/` 下的规格、代码、测试写入 seekdb（嵌入式 `@oceanbase/seekdb-node`），建立 ik 全文索引；
`node src/cli.mjs context` / `prompt` 用 `MATCH ... AGAINST` 检索后组装上下文。

- 入库统计：`spec 12 / test 9 / task 4 / code 1`，共 26 个切片
- 检索结果：`evidence/context-T-1042.json`（含每条命中的 path / symbol / score / snippet）
- 命中示例：`SPEC-pagination#p0` 6.32、`SPEC-filtering#p0` 5.11、`test_tag_filter_combines_with_status` 5.60、`test_filter_by_tag` 4.30、`test_page_zero_normalized_to_first_page` 3.74、`app/tickets.py:list_tickets` 3.42

## 3. 验证结果（修改前 / 修改后）

`node src/cli.mjs apply evidence/minimax-response-T-1042.md` 会先把 `sample/app/tickets.py` 恢复成修改前快照，
跑一次目标测试与回归测试，再应用模型改动、重跑同样的两组测试，因此「前失败 / 后通过」可重复核对。

| 阶段 | 目标测试 `tests/test_tickets_task.py` | 回归测试 `tests/test_tickets.py` |
|---|---|---|
| 修改前 | `exit=1`，`4 failed, 1 passed` | `exit=0`，`4 passed` |
| 修改后 | `exit=0`，`5 passed` | `exit=0`，`4 passed` |

原始 pytest 尾部输出见 `run-T-1042.json`（`before` / `after` 字段）以及本目录父级 PowerContext 状态快照
（`node src/cli.mjs state` 可读回，服务端重启后仍可读，见第 5 节）。

## 4. 代码差异

`evidence/changes-T-1042.diff` 是 `git diff -- minimax/sample/app/tickets.py` 的输出，与
`minimax-response-T-1042.md` 里的代码块逐字一致（`minimax-agent-calls.jsonl` 里记录了回复文件的 sha256，可用于校验未被事后修改）。

只改 `app/tickets.py` 一个文件；两份测试文件的断言未做任何修改（模型在回复里另附的两份测试文件未被采用，`apply` 只接受 `file=app/tickets.py` 这一个块）。

## 5. 状态落库（PowerContext）

| 项 | 值 |
|---|---|
| Scope | `scp_4ryw6s7cf2rnk9jxx4ermqabha`（标题：SDD 上下文模块 T-1042） |
| Artifact | `atomic-memory / art_d9c1bb2f0c4b4a4496c170800149cb73`（rev 1） |
| 读回 | `node src/cli.mjs state` 可读回 completed / todo / verification |
| 重启后读回 | 已验证：服务端进程重启后再次 `state`，仍返回同一条记录（`previous_state_found: true`） |

## 6. 复现命令

```bash
npm install
node src/cli.mjs import                       # 写入 seekdb 并建 ik 索引
node src/cli.mjs prompt                       # → evidence/prompt-T-1042.md
# 把 prompt 整段贴进 MiniMax Agent，回复另存为 evidence/minimax-response-T-1042.md
node src/cli.mjs apply evidence/minimax-response-T-1042.md \
  --provider="MiniMax Code 网页端 (agent.minimax.cn)" \
  --model="MiniMax-M3.1-Flash" \
  --session="https://agent.minimax.cn/mavis?id=463523103461753"
node src/cli.mjs state                        # 读回 PowerContext 中的任务状态
```

`apply` 与 `state` 需要 `POWECONTEXT_URL` 指向已启动的 PowerContext Server（默认 `http://127.0.0.1:8787`）；
`import` / `context` / `prompt` 只需要 `npm install` 装好的嵌入式 seekdb。
