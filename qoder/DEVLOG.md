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
