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
git clone <this repo> && cd <repo>
npm start                      # 零依赖静态服务器，默认 3000 端口
# 打开 http://localhost:3000
```

页面打开后无需任何后端：

1. 默认展示预置查询「中文分词器怎么选」——**命中数与耗时来自 seekdb 实测**（4 条命中、0.761 ms）；
2. 在搜索框输入任意关键词（例如「倒排索引」）——页面在 28 个切片上按 BM25 打分并排序，结果带分数与耗时；
3. 下方表格是导出数据时 12 组预置查询的 seekdb 实测基准。

> 索引数据内嵌在 `qoder/web/index.html` 里，所以直接双击该文件（`file://`）也能检索，不依赖本地服务器。

### 验收对照

| 题目要求 | 本仓库对应位置 |
|---|---|
| 用 Qoder 开发 | 项目由 Qoder CLI 产出并迭代；`qoder/.StudyLens.qoder.site` 是 Qoder Sites 的发布元数据（含 projectId / siteId / deploymentId / artifact 摘要） |
| 实际使用 seekdb | `qoder/src/db.mjs` 建表并建 `FULLTEXT ... WITH PARSER ik` 索引；`qoder/src/ingest.mjs` 按 `(doc, heading)` 幂等导入；`qoder/src/search.mjs` 用 `MATCH(body) AGAINST(?) IN NATURAL LANGUAGE MODE` 取 BM25 分数 |
| 通过 Qoder Sites 发布 | 线上地址 https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录） |
| 核心功能可运行 | 页面默认即展示 seekdb 实测检索结果；任意关键词在 28 个切片上按 BM25 排序；索引内嵌，`file://` 或任意静态服务器均可运行 |

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
