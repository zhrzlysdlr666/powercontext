# StudyLens · seekdb 驱动的学习资料检索台

OceanBase 2026 数据库大赛 **Qoder 赛题**参赛作品。把论文、课程笔记、项目踩坑记录切片写进
**seekdb**，中文分词与相关度排序交给 seekdb 的全文索引，检索结果通过 **Qoder Sites** 发布成
可直接使用的网页工作台 —— 解决「明明记过、却翻不到」的高频损耗。

- 作品页（public，无需登录）：https://studylens-lqny1ayu3yc.qoder.zone
- 提交物目录：[qoder/](./qoder/)
- 运行说明：[RUN.md](./RUN.md) · 验证样例：[VERIFY.md](./VERIFY.md) · 开发记录：[DEVLOG.md](./DEVLOG.md)

## 30 秒跑起来

```bash
pip install -r requirements.txt   # 只有 seekdb 客户端：pylibseekdb + pymysql
python main.py                    # 自检：建库 → 建 FULLTEXT(ik) → 灌 84 切片 → 6 条 MATCH 查询
python main.py --serve            # http://127.0.0.1:8899/（同时兜底 3000/8000/5000/8080）
```

预期末尾输出 `SELFCHECK PASS`，退出码 0。不需要 Docker，不需要单独起数据库服务。

## seekdb 在项目里承担什么

| 环节 | 实现 |
|---|---|
| 存储 | `chunks`（84 个切片）、`documents`（13 篇）、`query_log`（检索留痕） |
| 索引 | `CREATE FULLTEXT INDEX ft_chunk_body ON chunks(body) WITH PARSER ik`（中英文混排） |
| 检索 | `SELECT ... MATCH(body) AGAINST ('关键词') AS score ... ORDER BY score DESC` |
| 聚合 | 热词 `SELECT q, COUNT(*) FROM query_log GROUP BY q` |

代码在 [qoder/seekdb_store.py](./qoder/seekdb_store.py)。项目里没有第二套 JSON / 内存索引：
删掉 `qoder/data/seekdb` 后重跑 `python main.py` 会重新建库灌数。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /api/health` | seekdb 连接信息（引擎版本、解析器、切片数、累计检索数） |
| `GET /api/search?q=倒排索引` | 真跑 `MATCH ... AGAINST`，返回命中与耗时 |
| `GET /api/hot` / `GET /api/recent` | 热词 / 最近检索（来自 `query_log`） |
| `POST /api/reindex` | 强制重灌语料 |

## 目录

```text
qoder/main.py            入口：自检 / --serve / --reindex
qoder/seekdb_store.py    seekdb 存取层（建表、FULLTEXT(ik)、MATCH、query_log）
qoder/content/*.md       13 篇语料 → 84 个切片
qoder/web/index.html     作品页（检索台 + 核心功能 + seekdb 用法 + 运行验证 + 截图）
qoder/web/data/live.json seekdb 导出的静态快照（Qoder Sites 无后端时展示）
qoder/src/export_site.py 真查 seekdb 后导出快照并回写页面
qoder/verify.py          17 项一次性核对
app.py / main.py / main.mjs / run.sh / start.sh  多入口，最终都转到 qoder/main.py
```
