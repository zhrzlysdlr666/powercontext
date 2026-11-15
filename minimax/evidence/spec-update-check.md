# 规格更新 → 重新导入 → 上下文随之变化（验收项 3 的自测记录）

赛题要求：*规格更新并重新导入后，输出使用更新内容，不能始终返回固定答案*。
本文件是一次真实的最小对照：只改 `sample/specs/SPEC-filtering.md` 的 §1 表格里一行文字，其余不动。

## 操作步骤

```bash
# 基线：仓库原始规格
node src/cli.mjs import      # 重新切块并重建 ik 全文索引（按 path+symbol 幂等 upsert）
node src/cli.mjs context     # → ctx_after.json（下表"改前"）

# 把 SPEC-FILTERING §1 表格的「标签」那一行改掉（加一句 v3 说明）
node src/cli.mjs import
node src/cli.mjs context     # → ctx_v3.json（下表"改后"）

# 还原并重新导入，确认又回到原始内容（说明不是缓存/固定答案）
git checkout -- sample/specs/SPEC-filtering.md
node src/cli.mjs import
node src/cli.mjs context     # → ctx_clean.json：v3 文本消失
```

## 对照结果（`specs` 段中 `SPEC-filtering.md#p0` 这一条）

**改前**（score 5.3548）

```
SPEC-FILTERING 列表筛选规格 · 1. 支持的筛选维度
## 1. 支持的筛选维度
| 维度 | 参数 | 匹配方式 | 说明 |
|---|---|---|---|
| 状态 | `status` | 精确匹配 | open / closed |
| 优先级 | `priority` | 精确匹配 | P0 / P1 / P2 |
| 标签 | `tag` | 成员匹配 | 工单 `tags` 数组包含该标签即命中 |
```

**改后**（score 5.0045）

```
SPEC-FILTERING 列表筛选规格 · 1. 支持的筛选维度
## 1. 支持的筛选维度
| 维度 | 参数 | 匹配方式 | 说明 |
|---|---|---|---|
| 状态 | `status` | 精确匹配 | open / closed |
| 优先级 | `priority` | 精确匹配 | P0 / P1 / P2 |
| 标签 | `tag` | 成员匹配 | 工单 `tags` 数组包含该标签即命中；v3 更新：`tag=""` 等价于不启用标签筛选 |
```

改后条目里出现了新增的 `v3 更新：tag="" 等价于不启用标签筛选`，其余条目与分数基本不变；
把文件还原再 `import` 后该文本消失（见 `node src/cli.mjs context` 输出）。
说明上下文确实来自库内当前资料，而不是写死的答案。

> 注：`ctx_after.json` / `ctx_v3.json` / `ctx_clean.json` 是临时输出，未提交；本文件中的两段即为其原始内容摘录。
