# StudyLens · seekdb 驱动的学习资料检索工作台

> 2026 OceanBase 数据库大赛 ·「Qoder」赛题作品
> 线上站点：**https://studylens-lqny1ayu3yc.qoder.zone**（Qoder Sites 发布，`public`，无需登录）
> 代码仓库：https://github.com/zhrzlysdlr666/powercontext/tree/2026-competition-ecosystem/qoder

资料切片写进 **seekdb**，中文分词与相关度排序由 seekdb 的全文索引（`FULLTEXT ... WITH PARSER ik`）
完成，检索结果做成一个网页工作台，通过 **Qoder Sites** 发布。

## 1. 解决什么问题

准备比赛、写论文、接手新项目时，真正花时间的不是「读」，而是「找到该读的那一段」。
资料散在几十个 Markdown 里，`grep` 只能匹配字面串：搜「中文分词怎么选」，找不到写着
「IK 分词器的两种模式」的段落；搜「倒排索引」，也找不到标题写作「建表与全文索引」的那一节。

StudyLens 把资料按语义边界（二级标题）切片入 seekdb，用 IK 分词 + BM25 做中文检索，
再把这些检索结果做成可以直接演示的页面：输入关键词，立刻看到命中的段落、来源文档和分数。

## 2. 核心功能

| 功能 | 入口 | 说明 |
|---|---|---|
| 即时检索 | 页面搜索框 | 输入即搜（120 ms 防抖），中文按词切分，按 BM25 排序，结果带分数与耗时 |
| 命令行检索 | `node src/search.mjs "倒排索引"` | 走 seekdb 全文索引，返回 doc/heading/score |
| HTTP 检索接口 | `GET /api/search?q=倒排索引` | 评审或脚本可直接探测的接口，返回 JSON；`GET /api/health` 返回索引规模 |
| 实测基准 | 页面下方表格 | 12 组预置查询的命中数与端到端耗时，导出时由 seekdb 实测 |

## 3. 快速开始

**A. 自检模式（首选：几秒结束、退出码 0、只用 Python 标准库）**

```bash
cd qoder
python main.py          # 不需要 node、不需要 pip install、不依赖外网
# StudyLens selfcheck (python)
#   ok   index export — 28 chunks / 5 docs
#   ok   page 搜索框 — 62492 chars
#   ok   search "中文分词器怎么选" — 4 hits, 0.761 ms, engine=seekdb (exported), ...
#   ...
# SELFCHECK PASS
```

有 node 的环境等价命令：`node main.mjs`（`npm run selfcheck`），检查项与输出一致。

**B. 服务模式（给浏览器，常驻）**

```bash
python main.py --serve     # http://127.0.0.1:8899/ （$PORT 可改）
node main.mjs --serve      # 或者用 node 版，http://127.0.0.1:3000/
```

**C. Docker 一条命令**

```bash
docker compose up --build      # 或 docker build -t studylens . && docker run -p 3000:3000 studylens
```

**D. 直接打开文件**

`web/index.html` 把索引数据内联在页面里，双击用浏览器打开（`file://`）同样可以检索。

服务模式下搜索框已预填「中文分词器怎么选」并展示 seekdb 实测结果；在框里输入任意关键词，结果即时重排。

## 4. 验证样例（可逐步执行，含预期输出）

初始数据：`content/` 下 5 篇 Markdown → 28 个切片（按二级标题切），入库后由 seekdb 建 IK 全文索引。
启动服务后：

```bash
curl -s localhost:3000/api/health
# {"ok":true,"engine":"seekdb (FULLTEXT + IK parser, BM25)","chunks":28,"docs":5,"presets":12,"entry":"web/index.html"}

curl -s "localhost:3000/api/search?q=%E4%B8%AD%E6%96%87%E5%88%86%E8%AF%8D%E5%99%A8%E6%80%8E%E4%B9%88%E9%80%89"
# {"q":"中文分词器怎么选","engine":"seekdb","source":"preset-export","latencyMs":0.761,"total":4,
#  "hits":[{"doc":"seekdb 快速上手","topic":"seekdb","heading":"建表与全文索引","score":2.317, ...}, ...]}

curl -s "localhost:3000/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"
# {"q":"倒排索引","engine":"bm25","source":"index-export","latencyMs":0.4,"total":8,
#  "hits":[{"doc":"全文索引与中文分词","heading":"倒排索引的基本结构","score":10.345, ...}, ...]}
```

一键自检（自己起服务、打两个接口、再退出）：

```bash
npm run smoke
# GET /api/health -> {"ok":true,...}
# GET /api/search?q=倒排索引 -> {"engine":"bm25","total":8,...}
# SMOKE OK
```

`engine:"seekdb"` 的返回来自 seekdb 的实测导出（`latencyMs` 是 seekdb 单次查询耗时）；
`engine:"bm25"` 是页面/接口在导出的 28 个切片上按同一组 BM25 参数重排（导出时已用 seekdb 校验排序一致）。

## 5. seekdb 在项目里的实际作用

| 环节 | 文件 | 做了什么 |
|---|---|---|
| 建库建表 | `src/db.mjs` | `seekdb.open(dir)` 打开嵌入式实例；建 `study_docs` 表，`FULLTEXT INDEX ft_body (body) WITH PARSER ik` |
| 切片入库 | `src/ingest.mjs` | 按二级标题切片，标题拼进正文；`(doc, heading)` 唯一键 + `ON DUPLICATE KEY UPDATE`，重复导入不产生重复切片 |
| 检索 | `src/search.mjs` | `MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE)` 直接取 BM25 分数并排序；`--export` 产出页面所需数据 |
| 结果可见 | `web/index.html` | 预置查询的命中段落、分数、耗时全部来自上面的导出 |

重建索引（需要 seekdb 运行时，首次会 `npm install` 拉 `@oceanbase/seekdb-node`）：

```bash
npm install
node src/ingest.mjs                 # 输出：写入 28 个切片 + 按主题统计
node src/search.mjs "倒排索引 词项"   # 命令行检索，走 seekdb
node src/search.mjs --export        # 重新导出 web/data/index.json
```

实测（28 个切片、12 组查询、预热后）：单次检索 **0.6–1.6 ms**。

## 6. 目录

```
content/            学习资料（Markdown，按二级标题切片）
src/db.mjs          seekdb 生命周期 + 建表（含 ik 全文索引）
src/ingest.mjs      切片 + 幂等导入
src/search.mjs      检索；--export 产出站点数据
src/serve.mjs       零依赖服务：静态页面 + /api/health + /api/search
src/smoke.mjs       一键自检
web/index.html      检索工作台（数据内联，file:// 也能用）
web/data/index.json 导出数据：切片、文档、12 组查询的真实命中与耗时
docs/qoder-development.md  Qoder 开发过程记录
Dockerfile, docker-compose.yml  一条命令起服务
.StudyLens.qoder.site  Qoder Sites 发布元数据（projectId / siteId / deploymentId / artifact 摘要）
```

## 7. 页面说明

- 顶部搜索框 + 8 个预置查询标签：点预置标签展示的是 **seekdb 的真实命中与实测耗时**；
- 手动输入任意关键词时，页面在 28 个切片上按 **BM25** 打分（k1=1.2, b=0.75，与 seekdb 全文检索同公式，页面内计算 <1 ms），结果带分数与耗时，来源标注为「索引内 BM25」；
- 底部两张表：12 组查询的检索基准（命中数 / 耗时）、资料库构成（文档 / 主题 / 切片数）。

## 8. 已知限制

- 切片按二级标题切，超长的单节不会二次拆分，相关度会被长度归一化稀释；
- 检索只做 BM25 关键词匹配，没有向量召回，语义相近但用词完全不同的查询会漏召回；
- 站点为静态托管：预置查询的命中与耗时是导出时 seekdb 的真实结果；任意关键词的排序在页面内按 BM25 完成，
  等价于同一索引上的检索，但不等同于「每次请求都访问 seekdb」。新增资料需重跑 `--export` 再发布。
