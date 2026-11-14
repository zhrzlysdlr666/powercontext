# project rules

- 检索与存储只走 seekdb：`qoder/seekdb_store.py` 负责建表、`FULLTEXT INDEX ... WITH PARSER ik`、
  `MATCH ... AGAINST` 查询与 `query_log` 落库。禁止在页面或脚本里另写一套 BM25 / JSON 索引充当检索实现。
- 入口保持可复现：`python main.py` 必须真连 seekdb 建库、灌语料、跑查询并输出 `SELFCHECK PASS`，
  退出码 0；`--serve` 起 HTTP 服务，页面通过 `/api/search` 拿结果。
- Node 入口（`main.mjs`）只做转调，不重复实现检索逻辑。
- 站点是静态托管：`web/index.html` 在探测不到后端时使用 `src/export_site.py` 由 seekdb 导出的快照，
  并在状态条明确标注「静态快照」，不得伪装成实时查询。
- 每次改动后同步 `RUN.md` / `VERIFY.md` 的命令与预期输出，并跑 `python qoder/verify.py` 确认 17 项全绿。
