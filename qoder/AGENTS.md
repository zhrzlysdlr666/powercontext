# AGENTS.md · StudyLens

给在这个仓库里继续工作的 AI 代理（Qoder / CLI）的约定。

## 这是什么

StudyLens：学习资料检索工作台。资料按二级标题切片写入 seekdb，用 IK 分词 + BM25 检索，
结果做成静态页面，通过 Qoder Sites 发布。

## 硬约定

1. `web/data/index.json` 是唯一数据源，页面与两个服务端（node / python）都读它；
   重新生成必须走 `node src/search.mjs --export`（数据来自 seekdb 实测）。
2. 页面必须能在 `file://` 下工作：索引内联在 `web/index.html` 的 `<script id="index-data">` 里，
   不允许引入新的网络请求作为首屏依赖。
3. 任何改动都要保持两条自检通过、且输出一致：
   - `python main.py`（纯标准库）
   - `node main.mjs`（Node ≥ 18）
   两者最后一行都必须是 `SELFCHECK PASS`、退出码 0。
4. 新增依赖要谨慎：Python 侧坚持只用标准库；Node 侧 `src/serve.mjs` 与 `main.mjs` 不允许引入 npm 包
   （`@oceanbase/seekdb-node` 只服务 `src/ingest.mjs` / `src/search.mjs`）。
5. 改完要更新 `验证样例.md` 里的预期输出，跑一次 `docs/smoke_results.json` 的采集。

## 目录

`content/` 原始资料 · `src/` seekdb 与导出 · `web/` 页面 · `main.py`/`main.mjs` 单入口 · `docs/` 记录
