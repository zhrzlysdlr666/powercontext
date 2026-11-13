# StudyLens · seekdb 驱动的学习资料检索工作台

> 2026 OceanBase 数据库大赛 ·「Qoder」赛题作品
> 一个把零散学习资料变成可检索知识库的小工具：资料切片入 **seekdb**，中文分词与相关度排序由 seekdb 的全文索引完成，检索结果通过 **Qoder Sites** 发布成可分享的网页。

## 1. 解决什么问题

准备比赛、写论文、接手新项目时，真正花时间的不是「读」，而是「找到该读的那一段」。资料躺在几十个 Markdown 里，`grep` 只能匹配字面串，搜「中文分词怎么选」找不到写着「IK 分词器的两种模式」的段落。

StudyLens 把资料按语义边界切片存进 seekdb，用 IK 分词 + BM25 做中文检索，再把检索结果做成一个可以直接演示的网页工作台：输入关键词，立刻看到命中的段落、来源文档和相关度分数。

## 2. 为什么是 seekdb

| 需求 | 做法 |
|---|---|
| 中文检索要能召回近义表达 | seekdb 全文索引 `FULLTEXT ... WITH PARSER ik`，中文按词切分而不是按字 |
| 结果要有相关性排序 | `MATCH(body) AGAINST(?) IN NATURAL LANGUAGE MODE` 直接返回 BM25 分数，按分数倒序即可 |
| 反复修订资料不能出重复切片 | `(doc, heading)` 唯一键 + `ON DUPLICATE KEY UPDATE`，导入天然幂等 |
| 不想额外装数据库服务 | seekdb 是嵌入式形态，SDK 打开一个目录就是实例 |

实测（28 个切片、12 组查询、预热后）：单次检索 **0.6–1.6 ms**。

## 3. 结构

```
content/            学习资料（Markdown，按二级标题切片）
src/db.mjs          seekdb 生命周期 + 建表（含 ik 全文索引）
src/ingest.mjs      切片 + 幂等导入
src/search.mjs      检索；--export 产出站点所需数据
web/index.html      检索工作台（静态，读 data/index.json）
web/data/index.json 导出数据：切片、文档、12 组查询的真实命中与耗时
```

## 4. 运行

```bash
npm install
node src/ingest.mjs                 # 导入资料，输出切片统计
node src/search.mjs "倒排索引 词项"   # 命令行检索
node src/search.mjs --export        # 重新导出 web/data/index.json
node src/embed.mjs                  # 把导出数据内联进 web/index.html
```

浏览：仓库根目录 `npm start`（零依赖静态服务器），或直接双击 `web/index.html`。
数据内联在页面里，所以 `file://` 打开也能检索，不依赖 `fetch`。

## 5. 页面说明

- 顶部搜索框 + 8 个预置查询标签：点预置标签展示的是 **seekdb 的真实命中与实测耗时**；
- 手动输入其他关键词时，页面在 28 个切片上按 **BM25** 打分（k1=1.2, b=0.75，与 seekdb 全文检索同公式，页面内计算 <1 ms），结果带分数与耗时，来源标注为「索引内 BM25」；
- 底部两张表：12 组查询的检索基准（命中数 / 耗时）、资料库构成（文档 / 主题 / 切片数）。

## 6. 已知限制

- 切片按二级标题切，超长的单节不会二次拆分，相关度会被长度归一化稀释；
- 检索只做 BM25 关键词匹配，没有向量召回，语义相近但用词完全不同的查询会漏召回；
- 站点为静态托管：预置查询的命中与耗时是导出时 seekdb 的真实结果；任意关键词的排序在页面内按 BM25 完成，等价于同一索引上的检索，但不等同于「每次请求都访问 seekdb」。新增资料需重跑 `--export` 与 `--embed` 再发布。
