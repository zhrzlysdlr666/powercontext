# 2026 OceanBase 数据库大赛 · 参赛工作区

一个仓库放多道赛题的提交物，每道题一个目录，互不干扰。

| 目录 | 赛题 | 内容 |
|---|---|---|
| `qoder/` | Qoder | StudyLens —— seekdb 全文检索驱动的学习资料检索台，已用 Qoder Sites 发布 |
| `stepfun/` | 阶跃星辰 | 检索评测与 RRF 调参工具 |
| `gaode/` | 高德地图 | 场景方案 |
| `minimax/` | MiniMax | 场景方案 |
| `dify/` | Dify | 工作流 |

## Qoder 赛题：StudyLens

**在线站点：https://studylens-lqny1ayu3yc.qoder.zone**

一个把零散学习资料变成可检索知识库的小工具：资料按二级标题切片写入 **seekdb**，中文分词与相关度排序由 seekdb 的全文索引（`FULLTEXT ... WITH PARSER ik`）完成，检索结果经 **Qoder Sites** 发布成网页工作台。

### 30 秒验证

```bash
git clone <this repo> && cd <repo>/qoder
python main.py                 # 自检：读索引复算 BM25 → 打印 SELFCHECK PASS，退出码 0，约 1 秒
node main.mjs                  # 同一套检查的 node 版（环境里有 node 时）
```

两者都不需要 `npm install`，也不依赖外网。要看页面：

```bash
python main.py --serve         # http://127.0.0.1:8899/
node main.mjs --serve          # 或 npm start，常驻 3000 端口
```

一条命令起容器：`cd qoder && docker compose up --build`。

不打开浏览器也能验证主要功能：

```bash
curl -s localhost:3000/api/health
# {"ok":true,"engine":"seekdb (FULLTEXT + IK parser, BM25)","chunks":28,"docs":5,"presets":12,"entry":"web/index.html"}
curl -s "localhost:3000/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"
# {"q":"倒排索引","engine":"bm25","total":8,"latencyMs":0.39,"hits":[{"doc":"全文索引与中文分词","heading":"倒排索引的基本结构","score":10.345,...
```

页面打开后：

1. 默认展示预置查询「中文分词器怎么选」——**命中数与耗时来自 seekdb 实测**（4 条命中、0.761 ms）；
2. 在搜索框输入任意关键词（例如「倒排索引」）——输入即搜，页面在 28 个切片上按 BM25 打分并排序，结果带分数与耗时；
3. 下方表格是导出数据时 12 组预置查询的 seekdb 实测基准。

> 索引数据内嵌在 `qoder/web/index.html` 里，所以直接双击该文件（`file://`）也能检索，不依赖本地服务器。

### 验收对照

| 题目要求 | 本仓库对应位置 |
|---|---|
| 用 Qoder 开发 | 项目由 Qoder CLI 产出并迭代；`qoder/.StudyLens.qoder.site` 是 Qoder Sites 的发布元数据（含 projectId / siteId / deploymentId / artifact 摘要） |
| 实际使用 seekdb | `qoder/src/db.mjs` 建表并建 `FULLTEXT ... WITH PARSER ik` 索引；`qoder/src/ingest.mjs` 按 `(doc, heading)` 幂等导入；`qoder/src/search.mjs` 用 `MATCH(body) AGAINST(?) IN NATURAL LANGUAGE MODE` 取 BM25 分数 |
| 通过 Qoder Sites 发布 | 线上地址 https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录） |
| 核心功能可运行 | `cd qoder && npm start` 后：`/api/health` 返回索引规模、`/api/search?q=…` 返回命中 JSON、页面输入即搜；另有 `Dockerfile` / `docker-compose.yml` 一条命令起服务 |

### 用 seekdb 重建索引（可选，需要 seekdb 运行时）

```bash
cd qoder
npm install
node src/ingest.mjs              # 切片 + 幂等导入（(doc, heading) 唯一键）
node src/search.mjs "倒排索引 词项"  # 命令行检索，走 seekdb
node src/search.mjs --export     # 重新导出 web/data/index.json
node src/embed.mjs               # 把导出的数据内联回网页
```

### 一键自检

```bash
python verify.py     # 8 项：数据内联、首屏预渲染、线上可达、可见结果
```

开发过程（Qoder CLI 各阶段的真实命令与产物）见 [`qoder/docs/qoder-development.md`](qoder/docs/qoder-development.md)。

细节见 [`qoder/README.md`](qoder/README.md)。
