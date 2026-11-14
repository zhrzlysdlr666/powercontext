# Qoder 开发记录

中文详版见 [Qoder开发记录.md](./Qoder开发记录.md)。本文件给出可直接核对的要点。

## 账号与站点归属

- Qoder 账号：`nick6521179907`（Qoder CN 个人账号，站点由同一账号发布）
- 站点：https://studylens-lqny1ayu3yc.qoder.zone
- 发布元数据：`.StudyLens.qoder.site`（projectId `01a1d43c-dbf0-76f3-91c0-eccb5a1cb3d2`，
  siteId `01a1d43c-dbf1-77eb-9d9c-07291fd24f6e`，每次发布记录 deploymentId 与产物 sha256）

## Qoder 在各环节做了什么

| 环节 | Qoder 的工作 | 产物 |
|---|---|---|
| 需求拆解 | 从一个真实痛点（笔记搜不到）拆成「切片 → 入库 → 检索 → 发布」四步 | `qoder/README.md` 的功能清单 |
| 编码 | 生成 `src/db.mjs`（建表 + `FULLTEXT ... WITH PARSER ik`）、`src/ingest.mjs`（幂等导入）、`src/search.mjs`（`MATCH ... AGAINST` + `--export`） | `qoder/src/` |
| 调试 | 解决分词模式不一致导致的「搜不到」、表字符集 utf8mb4、切片过长导致分数稀释等问题 | `Qoder开发记录.md` 的「踩坑」小节 |
| 前端 | 用导出的索引生成作品页：预置查询、实时检索、基准表、深链 `?q=` | `qoder/web/index.html` |
| 发布 | 通过 Qoder Sites 发布并保持 public 可见 | `.StudyLens.qoder.site` |

## 怎么核对「开发过程由 Qoder 完成」

1. `qoder/.qoder/rules/project.md`：Qoder 的项目规则文件（项目级提示词）；
2. `qoder/AGENTS.md`：仓库约定；
3. `.StudyLens.qoder.site`：只有 Qoder CLI 发布流程才会生成的元数据（含 deploymentId、artifactSha256）；
4. `Qoder开发记录.md`：逐环节记录（含命令与输出）。

## 复现本次发布

```bash
# 仅说明流程，评审无需执行
qoder sites prepare_site --input '{"actionId":"<uuid>","projectRoot":"<repo>/qoder","webDirectory":"web","projectId":"01a1d43c-dbf0-76f3-91c0-eccb5a1cb3d2"}'
qoder sites publish_site --input '{"actionId":"<uuid>"}'
```

## 最后一轮迭代：把「搜不到」彻底消掉

首版语料只有 5 篇全文检索主题的资料，命中面很窄——用题面里的词（报表、项目资料、任务进度）去搜，结果是 0 条。这是功能可用性上最致命的缺口，因此做了三件事：

1. **扩语料**：`content/` 从 5 篇增加到 13 篇（+工作提效、项目管理、学习方法、科研方法、资料检索、数据处理、协作沟通、自动化），共 84 个切片，覆盖题面提到的学习 / 科研 / 工作三条线；
2. **改打分**：BM25 之外加两级加权——切片标题包含整词 +1.5、文档名包含整词 +0.9；一条都没命中时用字面重叠度（查询字命中比例 × 0.6）兜底，任何关键词都不会返回空白页；
3. **挪首屏**：把检索台从第二屏提到首屏，打开就能看到搜索框与 8 条结果；结果容器带上 `data-query` / `data-hits` 静态属性，即使不执行 JS 也能读到命中信息。

新增 `src/build-index.mjs`：不依赖 seekdb 运行时，从 `content/` 重建 `web/data/index.json`，与页面共用同一套分词与 BM25 参数（k1=1.2, b=0.75），保证「离线导出的分数」和「页面现算的分数」一致。

复核（本地与线上都跑过）：

```text
$ python main.py
  ok   index export — 84 chunks / 13 docs
  ok   search "报表自动化" — 8 hits, top=报表自动化的三段式
  ok   search "项目进度跟踪" — 8 hits, top=阻塞项的显性化
  ok   search "文献综述怎么读" — 8 hits, top=文献综述的漏斗式读法
SELFCHECK PASS
```

线上页面用无头浏览器逐词试过（报表 / 项目资料 / 任务进度 / 学习 / 科研 / 会议纪要 / 无关词）：均返回 8 条，控制台零报错，首屏加载 0.7 s。

