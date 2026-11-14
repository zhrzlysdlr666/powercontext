# 仓库约定（qoder/）

- 数据源只有一个：seekdb。表结构、索引、查询都在 `seekdb_store.py`，不要在别处复制一份语料或打分逻辑。
- `python main.py` 是唯一权威自检；`node main.mjs` / `run.sh` / `start.sh` 只是它的包装。
- 语料放 `content/*.md`，按二级标题切片；改语料后跑 `python main.py --reindex` 重灌。
- 改完代码跑 `python verify.py`（17 项：连接、条数、6 条查询、query_log、页面、截图、快照）。
- 发布站点前跑 `python src/export_site.py`，确保线上快照来自最新一次 seekdb 查询。
