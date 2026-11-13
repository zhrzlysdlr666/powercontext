# StudyLens 开发记录（Qoder CLI）

记录这个项目里**由 Qoder 实际完成的部分**，方便评审核对「项目必须使用 Qoder 开发」这一条。
所有命令都是本机真实执行过的，产物在仓库里可对照。

## 环境

- Qoder CN CLI：`@qodercn-ai/qoderclicn`（bin：`qoderclicn`），个人专业版（学生权益）
- 平台：Qoder Sites（`qoder/.StudyLens.qoder.site` 为发布元数据）
- seekdb：`@oceanbase/seekdb-node`（嵌入式，SDK 打开目录即实例）

## 阶段一：选题与骨架

对话式生成，产物是 `qoder/` 下的目录结构与三个脚本：

```bash
qoderclicn -p "用 seekdb 做一个学习资料检索台：Markdown 按二级标题切片入库，
建 FULLTEXT ... WITH PARSER ik 索引，用 MATCH ... AGAINST 取 BM25 分数，最后导出成静态页"
```

产出：`src/db.mjs`（生命周期 + 建表 + ik 索引）、`src/ingest.mjs`（切片 + 幂等导入）、
`src/search.mjs`（检索 / `--export`）。

## 阶段二：数据与基准

```bash
node src/ingest.mjs                 # 5 篇资料 -> 28 个切片
node src/search.mjs "倒排索引 词项"   # 命令行检索，走 seekdb
node src/search.mjs --export        # 导出 web/data/index.json（12 组预置查询的命中与耗时）
```

预置查询的耗时是 seekdb 实测（预热后 0.6–1.6 ms），不是估算。

## 阶段三：站点发布

```bash
qoderclicn -p "把当前目录的静态站点发布到 Qoder Sites，webDirectory 是 web，站点名 StudyLens"
```

发布后平台自动生成 `.StudyLens.qoder.site`（含 projectId / siteId / deploymentId / artifact 摘要），
线上地址 <https://studylens-lqny1ayu3yc.qoder.zone>。

## 阶段四：让站点在没有后端时也能跑

第一版页面运行时 `fetch('data/index.json')`，只有静态服务器在场才可用；直接用 `file://` 打开
或抓取 HTML 都看不到结果。改成：

- `src/embed.mjs` 把导出数据内联进 `web/index.html`，并把首屏（结果卡片、基准表、资料表）**预渲染成静态 HTML**；
- 自由关键词改成在页内按 BM25（k1=1.2, b=0.75）排序，替掉原来的二元组近似，结果带分数与耗时；
- 仓库根加 `npm start`（`qoder/src/serve.mjs`，零依赖静态服务器）。

现在禁用 JavaScript 也能看到 4 条命中、分数与 `0.76 ms` 的实测耗时；开启后输入关键词即时重排。

## 可复核的产物

| 产物 | 说明 |
|---|---|
| `web/data/index.json` | 28 个切片、5 篇文档、12 组查询的真实命中与耗时 |
| `web/index.html` | 内联数据 + 预渲染首屏，`file://` 可直接打开 |
| `.StudyLens.qoder.site` | Qoder Sites 发布元数据（平台生成，未手改） |
| 线上站点 | https://studylens-lqny1ayu3yc.qoder.zone |
