# 验证样例（可按步骤执行）

全部命令都在仓库根执行（在 `qoder/` 目录内执行时去掉 `qoder/` 前缀）。
依赖只需一次 `pip install -r requirements.txt`。

## 样例 0：环境确认

```bash
python -c "import pylibseekdb, pymysql; print('seekdb client ok')"
```

预期：`seekdb client ok`。

## 样例 1：自检（真连 seekdb，约 3–10 秒）

```bash
python main.py
```

预期输出（数值可能因机器略有差异，关键是 6 条查询都 `ok`、末尾 `SELFCHECK PASS`、退出码 0）：

```text
StudyLens selfcheck (seekdb embedded)
  ok   seekdb 连接 — embedded / 5.7.25-OceanBase seekdb-v1.4.0.0 / db=studylens
  ok   语料入库 — 84 切片 / 13 文档（本次写入）
  ok   全文索引 — FULLTEXT INDEX ... WITH PARSER ik
  ok   MATCH "中文分词器怎么选" — 8 命中 / 8.34 ms / top=建表与全文索引
  ok   MATCH "倒排索引" — 8 命中 / 2.12 ms / top=倒排索引的基本结构
  ok   MATCH "报表自动化" — 6 命中 / 1.61 ms / top=报表自动化的三段式
  ok   MATCH "项目进度跟踪" — 8 命中 / 2.15 ms / top=阻塞项的显性化
  ok   MATCH "文献综述怎么读" — 4 命中 / 1.49 ms / top=文献综述的漏斗式读法
  ok   MATCH "工作提效" — 4 命中 / 1.28 ms / top=重复劳动的识别与拆解
  ok   页面 检索台 — 41178 字符
  ok   页面 首屏预渲染 — 41178 字符

SELFCHECK PASS
```

这一步同时证明了「真实组件接入」：`chunks` 表、`FULLTEXT(ik)` 索引和 `MATCH` 查询都在运行时创建并执行。

## 样例 2：起服务后调接口

```bash
python main.py --serve &                 # http://127.0.0.1:8899/
curl -s http://127.0.0.1:8899/api/health
curl -s "http://127.0.0.1:8899/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"
```

`/api/health` 预期（关键字段）：

```json
{"ok":true,"engine":"seekdb","mode":"embedded","version":"5.7.25-OceanBase seekdb-v1.4.0.0",
 "parser":"ik","index":"FULLTEXT INDEX ft_chunk_body (MATCH ... AGAINST)",
 "docs":13,"chunks":84,"queries":0}
```

`/api/search?q=倒排索引` 预期：`total=8`，第一条 `heading="倒排索引的基本结构"`，
`score≈2.62`，`latencyMs` 在 1–10 ms 量级。

## 样例 3：数据真的存在 seekdb 里（不是 JSON 文件）

```bash
python main.py --reindex                 # 清空并重灌
ls qoder/data/seekdb                     # 嵌入式引擎的数据目录（gitignore，运行时生成）
```

删掉 `qoder/data/seekdb` 再跑 `python main.py`，会重新建库灌数并照样 `SELFCHECK PASS`；
仓库里没有任何检索用的索引 JSON（`web/data/live.json` 只是站点静态快照，由
`python qoder/src/export_site.py` 真查 seekdb 后导出）。

## 样例 4：查库核对（可选，用服务端模式更直观）

```bash
export SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2881
python main.py --serve &
curl -s "http://127.0.0.1:8899/api/stats"     # 附带 hot / recent（来自 query_log 聚合）
```

`/api/hot` 返回的是 `SELECT q, COUNT(*) FROM query_log GROUP BY q` 的结果——
检索行为被写进 seekdb，热词由 SQL 聚合得出，不是前端写死的数组。

## 样例 5：线上作品页

打开 https://studylens-lqny1ayu3yc.qoder.zone

- 首屏就是检索台，默认展示「中文分词器怎么选」的 8 条命中；
- 输入「倒排索引」「报表自动化」「文献综述怎么读」等，均返回结果并显示耗时；
- 深链 `?q=倒排索引` 打开即出结果；
- 页面下方「seekdb 在项目里做了什么」列出建表 / 建索引 / 查询三条 SQL，可与
  `qoder/seekdb_store.py` 逐行对照。

> 站点是静态托管，`/api/*` 由网关保留，因此线上展示的是 seekdb 导出的快照（页面会标注
> 「静态快照（由 seekdb 导出）」）；需要看实时检索请按样例 2 在本地起服务。
