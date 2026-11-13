# 一页技术说明：SDD 上下文模块

## 模块结构

```
sample/            业务工程 + 规格 + 测试（被修改的对象）
src/db.mjs         seekdb 生命周期与建表（ctx_docs / ctx_task_state）
src/ingest.mjs     规格按 ## 切、代码与测试按 def/class 切，写 ik 全文索引
src/context.mjs    任务文本 → seekdb 检索 → specs/code/tests 三段上下文
src/minimax.mjs    MiniMax Anthropic 兼容调用 + 调用证据落盘
src/dev.mjs        串联：读状态 → 组装上下文 → 模型修改 → 前后测试 → 写状态
src/state.mjs      PowerContext scope / memory 读写
src/cli.mjs        CLI 入口：import / context / dev / state
```

## 上下文选择方式

1. 任务文本前 240 字整段作为检索 query，交给 seekdb 的 `ik` 全文索引打分；
2. 同时抽出任务里的标识符（如 `list_tickets`），标题或符号精确命中的条目置顶；
3. 每类取 Top-3，三类合计不超过 9 条，避免上下文过长稀释约束；
4. 全文检索无命中时用标识符 `LIKE` 兜底，保证换了说法也能召回。

## 三项技术的分工

| 技术 | 承担 | 可核查证据 |
|---|---|---|
| seekdb | 工程资料存储 + 中文全文检索（`MATCH ... AGAINST` 在库内执行） | `evidence/context-T-1042.json` 里每条都带 `path/symbol/score` |
| MiniMax | 依据上下文产出 `app/tickets.py` 完整修改 | `evidence/minimax-calls.jsonl`（请求 id、token 用量、时延）+ `minimax-response-T-1042.md` |
| PowerContext | 任务状态（completed / todo / verification）持久化与跨重启复用 | `evidence/run-T-1042.json` 的 `powercontext.artifact`；`state` 命令读回同一条 |

## 规格变更后不会返回固定答案

每次 `import` 都是按文件内容 hash 做幂等 upsert：改了 `SPEC-pagination.md` 的归一化规则后重跑 `import`，`context` 输出的规格片段会变成新内容，`dev` 拿到的约束也随之变化——模块里没有任何硬编码的规格文本或补丁。

## 为什么状态要放 PowerContext 而不是本地文件

任务状态要跨会话、跨进程存活，且需要可审计的版本化记录。PowerContext 的 Atomic Memory 天然带 `artifact_id + revision`，写一次是一条 revision，读回时可以确认"这条状态是哪次写入的"，比本地 JSON 更接近真实协作场景。
