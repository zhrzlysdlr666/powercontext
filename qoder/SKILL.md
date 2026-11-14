# StudyLens · 项目说明（SKILL）

> 本文件是 `qoder/` 赛题提交物的入口说明。完整的运行说明见 [README.md](./README.md)，
> 验证步骤见 [VERIFY.md](./VERIFY.md)（中文版 `验证样例.md`），
> Qoder 开发过程见 [DEVLOG.md](./DEVLOG.md)（中文版 `Qoder开发记录.md`）。

## 一句话

把零散的学习资料（Markdown 笔记）按二级标题切片写进 **seekdb**，中文分词与相关度排序交给
seekdb 的 `FULLTEXT ... WITH PARSER ik` 全文索引，检索结果通过 **Qoder Sites** 发布成可直接使用的
网页工作台 —— 解决「记得看过、但搜不到那一段」的问题。

## 三项硬要求怎么满足

| 要求 | 落地位置 |
|---|---|
| 用 Qoder 开发 | 项目由 Qoder CLI 完成需求拆解、编码、调试与发布；`.qoder/rules/project.md` 是 Qoder 项目规则，`DEVLOG.md` 记录各环节做了什么，`.StudyLens.qoder.site` 是 Qoder Sites 的发布元数据（含 projectId / siteId / deploymentId / artifact 摘要） |
| 实际使用 seekdb | `src/db.mjs` 打开嵌入式 seekdb 并建 `FULLTEXT INDEX ft_body (body) WITH PARSER ik`；`src/ingest.mjs` 按 `(doc, heading)` 幂等导入 28 个切片；`src/search.mjs` 用 `MATCH(body) AGAINST(? IN NATURAL LANGUAGE MODE)` 取 BM25 分数 |
| 通过 Qoder Sites 发布 | 线上站点 https://studylens-lqny1ayu3yc.qoder.zone （public，无痕窗口可直接打开） |

## 怎么跑（零依赖）

```bash
python main.py        # 自检，打印 SELFCHECK PASS，退出码 0（纯标准库）
node main.mjs         # 同一套检查的 node 版
./run.sh              # 自动挑 python3 / python / node
./run.sh --serve      # 起服务：http://127.0.0.1:8899/
```

不需要 `pip install`，也不需要 `npm install`（主包零依赖，离线可用）。

## 目录

```
main.py / main.mjs     单入口（自检 / --serve）
src/db.mjs             建表 + FULLTEXT(IK) 索引
src/ingest.mjs         切片 + 幂等导入
src/search.mjs         MATCH ... AGAINST 检索 + --export 导出
web/index.html         作品页（索引内联，file:// 也能检索）
web/data/index.json    seekdb 导出的索引与 12 组实测查询
functions/index.ts     可选：Qoder Sites Edge Function 检索接口
```
