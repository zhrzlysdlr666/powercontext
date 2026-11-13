# Qoder 开发记录

题目要求「项目必须使用 Qoder 开发」，这份记录列出 Qoder 在这个项目里**实际做了什么**，
以及可以核对的产物。逐阶段的命令与产出见 [`docs/qoder-development.md`](docs/qoder-development.md)。

- 开发工具：Qoder CN CLI（`qoderclicn`，个人专业版）
- Qoder 账号：`nick6521179907`（站点归属同一个 Qoder 账号）
- 站点：Qoder Sites 发布，`https://studylens-lqny1ayu3yc.qoder.zone`（public，无需登录）
- 发布元数据：`.StudyLens.qoder.site` 内含 `projectId` / `siteId` / `deploymentId` / artifact 摘要，
  每次「发布」都会重写这个文件，可用来核对站点确实由 Qoder Sites 托管

## 阶段与产物

| 阶段 | 我给的指令（Qoder 对话） | Qoder 交付的产物 |
|---|---|---|
| 选题定型 | 「用 seekdb 做一个学习资料检索台：Markdown 按二级标题切片入库，建 IK 全文索引，用 MATCH…AGAINST 取 BM25 分数，最后导出成静态页」 | 目录骨架 + `src/db.mjs` / `src/ingest.mjs` / `src/search.mjs` |
| 数据闭环 | 「把 content 下 5 篇资料入库，跑 12 组预置查询，导出命中与耗时」 | 28 个切片入库、`web/data/index.json`（12 组查询实测 0.6–1.6 ms） |
| 站点 | 「把 web 目录发布到 Qoder Sites，站点名 StudyLens，可见范围 public」 | 线上站点 + `.StudyLens.qoder.site` 元数据 |
| 排查「主要功能跑不起来」 | 「评审按 README 启动后必须能直接验证：给一个几秒结束、退出码 0 的自检，再给常驻服务和 HTTP 接口」 | `main.mjs`（`--serve` 常驻 / 缺省自检）、`src/serve.mjs` 的 `/api/health` 与 `/api/search`、`验证样例.md`、`docs/smoke_results.json` |

## 怎么核对

1. 站点归属：`.StudyLens.qoder.site` 里的 `siteId` 与线上站点一致；站点页脚带 Qoder Sites 水印。
2. 主要功能：`node main.mjs` → 打印 `SELFCHECK PASS`、退出码 0（见 [`验证样例.md`](验证样例.md)）。
3. 代码来源：上面每个阶段的产物都在本目录内，提交历史里能看到对应改动。
