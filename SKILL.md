# StudyLens · 项目说明（SKILL）

本赛题提交物在 [qoder/](./qoder/)，完整说明见 [qoder/SKILL.md](./qoder/SKILL.md)。

## 一句话

把学习资料（Markdown 笔记）按二级标题切片写进 **seekdb**，中文分词与相关度排序交给
seekdb 的 `FULLTEXT ... WITH PARSER ik` 全文索引，检索结果通过 **Qoder Sites** 发布成
可直接使用的网页工作台 —— 解决「记得看过、但搜不到那一段」的问题。

## 三项硬要求

| 要求 | 落地位置 |
|---|---|
| 用 Qoder 开发 | `qoder/.qoder/rules/project.md`（项目规则）、`qoder/DEVLOG.md`（逐环节记录）、`.StudyLens.qoder.site`（Qoder Sites 发布元数据） |
| 实际使用 seekdb | `qoder/seekdb_store.py`：建表 → `FULLTEXT INDEX ... WITH PARSER ik` → 灌 84 切片 → `MATCH ... AGAINST` 查询 → `query_log` 留痕，热词用 SQL 聚合 |
| 通过 Qoder Sites 发布 | https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录） |

## 文档索引

- 运行说明：[RUN.md](./RUN.md) · [qoder/RUN.md](./qoder/RUN.md)
- 验证样例：[qoder/VERIFY.md](./qoder/VERIFY.md)
- Qoder 开发记录：[qoder/DEVLOG.md](./qoder/DEVLOG.md)
- 项目说明：[qoder/SKILL.md](./qoder/SKILL.md)

## 跑起来

```bash
pip install -r requirements.txt
python main.py             # 自检：真连 seekdb，打印 SELFCHECK PASS
python main.py --serve     # http://127.0.0.1:8899/
```
