# Qoder 开发记录

详细版见 [qoder/DEVLOG.md](./qoder/DEVLOG.md)。

## 账号与站点

- Qoder 账号：`nick6521179907`（站点由同一账号通过 Qoder Sites 发布）
- 站点：https://studylens-lqny1ayu3yc.qoder.zone
- 发布元数据：`qoder/.StudyLens.qoder.site`（projectId / siteId / deploymentId / 产物 sha256）

## 关键迭代

第一版是「导出的静态 BM25」：语料打成 JSON、页面自己算分，seekdb 只在导出时用一下。
这一轮改成真跑 seekdb —— 删掉自写 BM25 与 `web/data/index.json`，检索全部落到
`qoder/seekdb_store.py`（建表 + `FULLTEXT(ik)` + `MATCH ... AGAINST` + `query_log`），
页面只负责发请求和渲染；`node main.mjs` 也改成转调同一份 Python 实现，避免两套逻辑漂移。

## 怎么核对

1. `qoder/.qoder/rules/project.md`：Qoder 项目规则；
2. `qoder/DEVLOG.md`：各环节做了什么、踩了哪些坑；
3. `qoder/.StudyLens.qoder.site`：只有 Qoder Sites 发布流程才生成的元数据；
4. `qoder/seekdb_store.py`：seekdb 建表 / 索引 / 查询 SQL 全在这里。
