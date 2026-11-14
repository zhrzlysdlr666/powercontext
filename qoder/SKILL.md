# StudyLens · 项目说明（SKILL）

> `qoder/` 赛题提交物的入口说明。运行步骤见 [RUN.md](./RUN.md)，验证样例见 [VERIFY.md](./VERIFY.md)，
> Qoder 开发过程见 [DEVLOG.md](./DEVLOG.md)。

## 一句话

把零散的学习资料（Markdown 笔记）按二级标题切片写进 **seekdb**，中文分词与相关度排序交给
seekdb 的 `FULLTEXT ... WITH PARSER ik` 全文索引，检索结果通过 **Qoder Sites** 发布成可直接
使用的网页工作台 —— 解决「记得看过、但搜不到那一段」的问题。

## 三项硬要求怎么落地

| 要求 | 落地位置（可直接核对） |
|---|---|
| 用 Qoder 开发 | 项目由 Qoder 完成需求拆解、编码、调试与站点发布；`.qoder/rules/project.md` 是项目规则，`DEVLOG.md` 逐环节记录，`.StudyLens.qoder.site` 是 Qoder Sites 的发布元数据（projectId / siteId / deploymentId / 产物 sha256） |
| 实际使用 seekdb | `seekdb_store.py`：`pyseekdb/pylibseekdb` 打开嵌入式 seekdb → `CREATE TABLE chunks/documents/query_log` → `CREATE FULLTEXT INDEX ft_chunk_body ON chunks(body) WITH PARSER ik` → 灌 84 个切片 → 查询 `MATCH(body) AGAINST ('关键词')` 取相关度 → 每次检索 `INSERT INTO query_log`，热词用 `GROUP BY` 聚合 |
| 通过 Qoder Sites 发布 | https://studylens-lqny1ayu3yc.qoder.zone （public，无痕窗口可直接打开） |

seekdb 不是「装一下、连一下」，而是检索路径上唯一的数据源：
页面的每次查询都对应一条 `MATCH ... AGAINST` SQL，命中条数、分数、耗时都来自数据库返回。

## 怎么跑

```bash
pip install -r requirements.txt     # 只有 seekdb 客户端
python main.py                      # 自检：建库 + 灌 84 切片 + 6 条 MATCH 查询 → SELFCHECK PASS
python main.py --serve              # http://127.0.0.1:8899/（同时兜底 3000/8000/5000/8080）
./start.sh                          # 一键：缺依赖先装，再起服务
docker compose up --build           # 或容器方式
```

## 目录

```text
main.py                入口：自检 / --serve / --reindex
seekdb_store.py        seekdb 存取层（建表、FULLTEXT(ik)、MATCH 查询、query_log、热词聚合）
content/*.md           13 篇语料，切成 84 个检索片段
web/index.html         作品页：首屏检索台 + 核心功能 + seekdb 用法 + 运行验证 + 截图
web/data/live.json     seekdb 导出的静态快照（站点无后端时展示）
src/export_site.py     真查 seekdb 后导出快照并回写页面
verify.py              一次性核对脚本
```

## 为什么站点上看到的是「快照」

Qoder Sites 是静态托管，网关保留 `/api/*` 且不会运行 Python 进程。因此线上页面在探测不到后端时
切换到 seekdb 导出的快照，并在状态条明确标注「静态快照（由 seekdb 导出）」；本地
`python main.py --serve` 打开同一页面时，状态条会变成「seekdb 在线 · MATCH AGAINST」，
检索框走真实 `/api/search`。两条路径用的是同一份查询参数与同一份语料，不存在「两套检索」。
