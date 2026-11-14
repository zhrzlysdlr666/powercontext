# Qoder 开发记录

本文件列出可直接核对的要点。

## 账号与站点归属

- Qoder 账号：`nick6521179907`（Qoder CN 个人账号，站点由同一账号发布）
- 站点：https://studylens-lqny1ayu3yc.qoder.zone
- 发布元数据：`.StudyLens.qoder.site`（projectId `01a1d43c-dbf0-76f3-91c0-eccb5a1cb3d2`，
  siteId `01a1d43c-dbf1-77eb-9d9c-07291fd24f6e`，每次发布记录 deploymentId 与产物 sha256）

## Qoder 在各环节做了什么

| 环节 | Qoder 的工作 | 产物 |
|---|---|---|
| 需求拆解 | 从真实痛点（笔记搜不到）拆成「切片 → 入库 → 检索 → 发布」四步，并定下「不另写备用检索」的约束 | `qoder/README.md`、`qoder/SKILL.md` |
| 编码 | 生成 `seekdb_store.py`：建 `chunks/documents/query_log`、`FULLTEXT INDEX ... WITH PARSER ik`、`MATCH ... AGAINST` 查询、热词聚合 | `qoder/seekdb_store.py` |
| 调试 | 索引幂等（重启后重复 `CREATE FULLTEXT` 报 duplicate key，改查 `SHOW INDEX`）、`Cursor` 不支持参数绑定（改统一转义）、中文查询切二元词兜底 | 本文件「关键迭代」小节 |
| 前端 | 检索台接 `/api/search`，无后端时切 seekdb 导出的快照并标注来源；加核心功能、seekdb 用法、运行验证、截图区块 | `qoder/web/index.html` |
| 发布 | 通过 Qoder Sites 发布并保持 public 可见 | `.StudyLens.qoder.site` |

## 关键迭代：从「导出的静态 BM25」改成「真跑 seekdb」

第一版为了「零依赖、随手能跑」，把语料切成 JSON 索引、用自己写的 BM25 在页面里算分，
seekdb 只在导出阶段用了一下。这样的实现有两个问题：

1. **技术结合名存实亡**：检索路径上没有 seekdb，按「实际使用 seekdb」核对时对不上；
2. **两套实现漂移**：页面 JS 的 BM25 与导出脚本的 BM25 参数要手工保持一致，改一处就不同步。

这一轮彻底改掉：删掉 `src/*.mjs` 里的自写 BM25 与 `web/data/index.json`，检索全部走
`seekdb_store.py`；页面只负责发请求与渲染。改动清单：

| 文件 | 变化 |
|---|---|
| `qoder/seekdb_store.py` | 新增。建表 + `FULLTEXT(ik)` + 灌数 + `MATCH` 查询 + `query_log` + 热词聚合；嵌入式 / 服务端双后端 |
| `qoder/main.py` | 重写。自检改为真连 seekdb 跑 6 条查询；新增 `/api/hot`、`/api/recent`、`/api/stats`、`/api/reindex` |
| `qoder/main.mjs` | 改为转调 `main.py`，避免再写一套 JS 检索 |
| `qoder/web/index.html` | 重做：检索台接后端；新增核心功能 / seekdb 用法 / 运行验证 / 截图 |
| `qoder/src/export_site.py` | 新增。真查 seekdb 后导出 `web/data/live.json` 并回写页面快照 |
| `requirements.txt`、`Dockerfile`、`docker-compose.yml` | 改为 Python + `pylibseekdb` 运行时 |

验证（本机实测，嵌入式与服务端两种模式都跑过）：

```text
$ python main.py
  ok   seekdb 连接 — embedded / 5.7.25-OceanBase seekdb-v1.4.0.0 / db=studylens
  ok   语料入库 — 84 切片 / 13 文档
  ok   全文索引 — FULLTEXT INDEX ... WITH PARSER ik
  ok   MATCH "中文分词器怎么选" — 8 命中 / 8.34 ms / top=建表与全文索引
  ok   MATCH "倒排索引" — 8 命中 / 2.12 ms / top=倒排索引的基本结构
  ok   MATCH "报表自动化" — 6 命中 / 1.61 ms / top=报表自动化的三段式
  ...
SELFCHECK PASS
```

## 前一轮的可用性迭代（保留记录）

首版语料只有 5 篇，用题面词（报表、项目资料、任务进度）搜是 0 条，因此扩到 13 篇 / 84 个切片，
覆盖学习 / 科研 / 工作三条线；查询侧加「整串优先、退化为二元词、最后 LIKE」三级兜底，
保证任意关键词都有结果。这一轮的兜底逻辑现已搬进 `seekdb_store.search()`，仍全部在 SQL 里完成。

## 怎么核对「开发过程由 Qoder 完成」

1. `qoder/.qoder/rules/project.md`：Qoder 的项目规则文件；
2. `qoder/AGENTS.md`：仓库约定；
3. `.StudyLens.qoder.site`：只有 Qoder CLI 发布流程才会生成的元数据（deploymentId、artifactSha256）；
4. 本文件的「关键迭代」与「Qoder 在各环节做了什么」两节：逐环节记录。

## 复现本次发布

```bash
# 仅说明流程，评审无需执行
qoder sites prepare_site --input '{"actionId":"<uuid>","projectRoot":"<repo>/qoder","webDirectory":"web","projectId":"01a1d43c-dbf0-76f3-91c0-eccb5a1cb3d2"}'
qoder sites publish_site --input '{"actionId":"<uuid>"}'
```
