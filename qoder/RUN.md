# 运行说明（RUN）

StudyLens 的存储与检索跑在 **seekdb** 上：语料切片写进 `chunks` 表，建
`FULLTEXT INDEX ... WITH PARSER ik` 中文全文索引，查询走 `MATCH(body) AGAINST (...)`。
项目里没有第二套 JSON / 内存索引，Web 层与检索层是同一份代码。

## 0. 环境

- Python 3.8+，**推荐 3.12**：pylibseekdb 的 3.12 轮子自带 seekdb 引擎二进制，嵌入式实例开箱即用
  （本项目在 3.12.13 + pylibseekdb 1.4.0.post2 上实测通过）
- 依赖只有 seekdb 客户端：`pylibseekdb`（嵌入式引擎）+ `pymysql`（MySQL 协议驱动）
- 不需要 Docker，不需要单独启动数据库服务；Windows / Linux / macOS 均可
- 如果嵌入式实例起不来（例如 Python 3.13 的 abi3 轮子初始化失败），代码会自动探测本机
  2881/2883 上的 seekdb 服务端并切过去，仍然是同一个 seekdb 引擎、同一份 SQL

```bash
pip install -r requirements.txt
```

## 1. 自检（约 3–10 秒，退出码 0）

```bash
python main.py          # 仓库根入口，等价于 cd qoder && python main.py
./run.sh                # 自动挑 python3 / python
node main.mjs           # 只有一个 Node 环境时，转调同一份 Python 实现
```

自检做的事（不是读 JSON 比对，而是真连 seekdb）：

1. 打开嵌入式 seekdb（数据落在 `qoder/data/seekdb`），建库 `studylens`；
2. 建 `chunks` / `documents` / `query_log` 表与 `FULLTEXT(ik)` 索引；
3. 把 `qoder/content/*.md` 切成 84 个片段写库（内容哈希不变则跳过，幂等）；
4. 跑 6 条 `MATCH ... AGAINST` 查询并断言有命中。

预期输出：

```text
StudyLens selfcheck (seekdb embedded)
  ok   seekdb 连接 — embedded / 5.7.25-OceanBase seekdb-v1.4.0.0 / db=studylens
  ok   语料入库 — 84 切片 / 13 文档（本次写入）
  ok   全文索引 — FULLTEXT INDEX ... WITH PARSER ik
  ok   MATCH "中文分词器怎么选" — 8 命中 / 8.34 ms / top=建表与全文索引
  ...
SELFCHECK PASS
```

## 2. 起服务

```bash
python main.py --serve     # http://127.0.0.1:8899/
./start.sh                 # 一键：缺依赖时先 pip install，再起服务
```

服务会同时在 8899 / 3000 / 8000 / 5000 / 8080 上监听（被占用则跳过），绑定 `0.0.0.0`，
容器内外都能访问；主端口可用 `PORT` 覆盖。

接口：

| 路径 | 说明 |
|---|---|
| `GET /api/health` | seekdb 连接信息：`{"engine":"seekdb","mode":"embedded","version":"5.7.25-OceanBase seekdb-v1.4.0.0","parser":"ik","chunks":84,"docs":13,"queries":N}` |
| `GET /api/search?q=倒排索引` | 真跑 `MATCH ... AGAINST`，返回 `hits[]`（含 heading / doc / score / snippet）与 `latencyMs` |
| `GET /api/hot` | `query_log` 聚合出的热词 |
| `GET /api/recent` | 最近检索记录 |
| `POST /api/reindex` | 强制重灌语料（`python main.py --reindex` 等效） |

别名：`/health`、`/healthz`、`/search` 指向同名接口。

## 3. 看页面

浏览器打开 `http://127.0.0.1:8899/`（支持 `?q=关键词` 深链）。
页面里的检索框直接调 `/api/search`，状态条会显示「seekdb 在线 · MATCH AGAINST」与实测耗时。

线上作品页：https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录）。
Qoder Sites 是静态托管，`/api/*` 由网关保留不可用，所以站点在无后端时展示
**由 seekdb 导出**的静态快照（`python src/export_site.py` 生成，页面会标注「静态快照」）。

## 4. 服务端模式（可选）

不想用嵌入式引擎时，连一个 seekdb Server / OceanBase 即可，SQL 完全一样：

```bash
export SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2881 SEEKDB_USER=root SEEKDB_PASSWORD=
python main.py --serve
```

## 5. 容器（可选）

```bash
docker build -t studylens . && docker run --rm -p 3000:3000 studylens
docker compose up --build            # 等价
```

镜像基于 `python:3.12-slim`，启动时自动建库灌数，健康检查打 `/api/health`。

## 6. 重建 / 导出

```bash
python main.py --reindex          # 重新切片并重灌 seekdb（清空 chunks 后重建）
python qoder/src/export_site.py   # 用 seekdb 的真实查询结果刷新静态站点快照
python qoder/verify.py            # 一次性核对：连接、条数、6 条查询、页面产物
```

## 目录

```text
qoder/main.py           入口：自检 / --serve / --reindex
qoder/seekdb_store.py   seekdb 存取层：建表、FULLTEXT(ik) 索引、MATCH 查询、query_log
qoder/content/*.md      13 篇语料（84 个切片）
qoder/web/index.html    作品页（检索台 + 项目说明 + 截图）
qoder/web/data/live.json  seekdb 导出的静态快照（站点无后端时使用）
qoder/src/export_site.py 导出脚本（真查 seekdb 再写文件）
```
