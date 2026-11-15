你是 MiniMax 驱动的开发助手，在规格驱动开发（SDD）流程里完成一次局部代码修改。
只依据下面给出的规格、代码和测试做修改，不要引入未在规格中声明的行为。
测试文件只读，不得修改断言或新增依赖。

## 任务 T-1042

# 任务 T-1042：工单列表增加标签筛选并修正分页边界

## 背景

客服后台的工单列表当前只能按状态和优先级筛选。运营希望按标签（例如 perf、auth、export）快速圈出一批工单，用于批量处理性能类问题。

同时前端反馈：页码或页长传入非法值时，列表会出现"空页"或一次性返回全部数据，体验很差。

## 要改什么

1. `list_tickets` 增加 `tag` 参数，按标签筛选，并且可以和 status / priority 叠加（AND 关系）。
2. 分页参数按 SPEC-PAGINATION 做归一化：
   - `page < 1` 按 1 处理，返回值里的 `page` 是归一化后的值；
   - `page_size > 100` 按 100 处理，`page_size < 1` 按 20 处理；
   - 页码越界返回空 `items`，`total` 仍是筛选后的总数。

## 哪些原有行为必须保持

- 不传任何筛选参数时，返回第一页（默认 page=1 / page_size=20），`total` 等于全部工单数。
- 只按 status 或 priority 筛选的行为与现在一致，顺序保持入参顺序。
- 返回结构仍然是 `{items, page, page_size, total}` 四个键。
- 现有回归测试 `sample/tests/test_tickets.py` 必须全部通过。

## 验收

- 目标测试 `sample/tests/test_tickets_task.py` 在修改前失败、修改后全部通过。
- 回归测试 `sample/tests/test_tickets.py` 修改前后都通过。

## 已保存的任务状态（来自 PowerContext，可能为空）

（无，首次执行）

### 适用规格

````markdown title=specs/SPEC-pagination.md
# SPEC-PAGINATION 分页规格

编号：SPEC-PAGINATION
状态：生效中（v3，2026-10-28 修订）
适用范围：所有列表类接口，`list_tickets` 为第一个落地接口。

## 1. 输入参数

| 参数 | 类型 | 默认值 | 约束 |
|---|---|---|---|
| page | int | 1 | 页码从 1 开始；小于 1 时按 1 处理 |
| page_size | int | 20 | 每页条数；大于 100 时按 100 处理；小于 1 时按 20 处理 |

## 2. 输出约定

- `page` 返回**归一化之后**的页码，而不是调用方传入的原始值。
- `page_size` 返回**归一化之后**的每页条数。
- `total` 是筛选后的总条数，与分页无关。
- 页码越界时 `items` 为空列表，`total` 仍返回筛选后的总数，不报错。

## 3. 归一化示例

| 传入 | 归一化 | 说明 |
|---|---|---|
| page=0 | 1 | 非法页码回落到首页 |
| page=-3 | 1 | 负数同样回落到首页 |
| page_size=1000 | 100 | 上限截断 |
| page_size=0 | 20 | 非法页长回落到默认值 |

## 4. 历史决策

- 2026-09-14：曾允许 page=0 表示"第一页"，与前端 0-based 约定冲突，已废弃。当前统一 1-based，`page=0` 仅作为非法输入被归一化，不表示特殊语义。
````

````markdown title=specs/SPEC-filtering.md
# SPEC-FILTERING 列表筛选规格

编号：SPEC-FILTERING
状态：生效中（v2，2026-11-02 修订）
适用范围：工单列表 `list_tickets`。

## 1. 支持的筛选维度

| 维度 | 参数 | 匹配方式 | 说明 |
|---|---|---|---|
| 状态 | `status` | 精确匹配 | open / closed |
| 优先级 | `priority` | 精确匹配 | P0 / P1 / P2 |
| 标签 | `tag` | 成员匹配 | 工单 `tags` 数组包含该标签即命中 |

## 2. 组合规则

- 多个筛选维度之间是 **AND** 关系：工单必须同时满足全部条件。
- 参数为 `None` 表示不启用该维度，不能把 `None` 当成筛选值。
- 标签筛选必须容忍工单没有 `tags` 字段（视为空数组），不能抛异常。

## 3. 顺序约定

筛选项先全部应用，再计算 `total`，最后做分页切片。`total` 必须反映筛选后的条数，不是原始条数。

## 4. 变更记录

- v2（2026-11-02）：新增标签维度 `tag`。此前只支持状态与优先级。
- v1（2026-08-20）：初版，状态 + 优先级。
````

````markdown title=specs/SPEC-filtering.md
# SPEC-FILTERING 列表筛选规格

编号：SPEC-FILTERING
状态：生效中（v2，2026-11-02 修订）
适用范围：工单列表 `list_tickets`。

## 1. 支持的筛选维度

| 维度 | 参数 | 匹配方式 | 说明 |
|---|---|---|---|
| 状态 | `status` | 精确匹配 | open / closed |
| 优先级 | `priority` | 精确匹配 | P0 / P1 / P2 |
| 标签 | `tag` | 成员匹配 | 工单 `tags` 数组包含该标签即命中 |

## 2. 组合规则

- 多个筛选维度之间是 **AND** 关系：工单必须同时满足全部条件。
- 参数为 `None` 表示不启用该维度，不能把 `None` 当成筛选值。
- 标签筛选必须容忍工单没有 `tags` 字段（视为空数组），不能抛异常。

## 3. 顺序约定

筛选项先全部应用，再计算 `total`，最后做分页切片。`total` 必须反映筛选后的条数，不是原始条数。

## 4. 变更记录

- v2（2026-11-02）：新增标签维度 `tag`。此前只支持状态与优先级。
- v1（2026-08-20）：初版，状态 + 优先级。
````

### 需要修改的代码

````python title=app/tickets.py
"""工单列表服务（业务工程样本，供 SDD 上下文模块演示一次真实代码修改）。"""

from __future__ import annotations


def list_tickets(tickets, status=None, priority=None, page=1, page_size=20):
    """按状态/优先级筛选工单并分页返回。

    tickets: list[dict]，每项含 id / title / status / priority / tags
    返回 dict：{items, page, page_size, total}
    """
    items = list(tickets)

    if status is not None:
        items = [t for t in items if t.get("status") == status]
    if priority is not None:
        items = [t for t in items if t.get("priority") == priority]

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": items[start:end],
        "page": page,
        "page_size": page_size,
        "total": total,
    }
````

### 验证测试（只读，不得修改）

````python title=tests/test_tickets_task.py
"""本次任务的目标测试（修改前必须失败，修改后必须通过）。

对应任务 T-1042：工单列表增加标签筛选，并修正分页边界输入。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from tickets import list_tickets  # noqa: E402

TICKETS = [
    {"id": 1, "title": "登录页 500", "status": "open", "priority": "P0", "tags": ["auth"]},
    {"id": 2, "title": "导出超时", "status": "open", "priority": "P1", "tags": ["export", "perf"]},
    {"id": 3, "title": "文案错别字", "status": "closed", "priority": "P2", "tags": ["copy"]},
    {"id": 4, "title": "列表卡顿", "status": "open", "priority": "P1", "tags": ["perf"]},
]


def test_filter_by_tag():
    """新增：按标签筛选，只返回 tags 中包含该标签的工单。"""
    out = list_tickets(TICKETS, tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_tag_filter_combines_with_status():
    """标签筛选可与状态筛选叠加。"""
    out = list_tickets(TICKETS, status="open", tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_page_zero_normalized_to_first_page():
    """边界输入：page=0 视为第 1 页，返回首页数据而不是空列表。"""
    out = list_tickets(TICKETS, page=0, page_size=2)
    assert out["page"] == 1
    assert [t["id"] for t in out["items"]] == [1, 2]


def test_page_size_capped_at_100():
    """边界输入：page_size 超过 100 时按 100 处理。"""
    out = list_tickets(TICKETS, page=1, page_size=1000)
    assert out["page_size"] == 100
    assert out["total"] == 4


def test_out_of_range_page_returns_empty():
    """边界输入：页码越界返回空列表，total 仍为筛选后的总数。"""
    out = list_tickets(TICKETS, page=99, page_size=2)
    assert out["items"] == []
    assert out["total"] == 4
````

````python title=tests/test_tickets_task.py
"""本次任务的目标测试（修改前必须失败，修改后必须通过）。

对应任务 T-1042：工单列表增加标签筛选，并修正分页边界输入。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from tickets import list_tickets  # noqa: E402

TICKETS = [
    {"id": 1, "title": "登录页 500", "status": "open", "priority": "P0", "tags": ["auth"]},
    {"id": 2, "title": "导出超时", "status": "open", "priority": "P1", "tags": ["export", "perf"]},
    {"id": 3, "title": "文案错别字", "status": "closed", "priority": "P2", "tags": ["copy"]},
    {"id": 4, "title": "列表卡顿", "status": "open", "priority": "P1", "tags": ["perf"]},
]


def test_filter_by_tag():
    """新增：按标签筛选，只返回 tags 中包含该标签的工单。"""
    out = list_tickets(TICKETS, tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_tag_filter_combines_with_status():
    """标签筛选可与状态筛选叠加。"""
    out = list_tickets(TICKETS, status="open", tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_page_zero_normalized_to_first_page():
    """边界输入：page=0 视为第 1 页，返回首页数据而不是空列表。"""
    out = list_tickets(TICKETS, page=0, page_size=2)
    assert out["page"] == 1
    assert [t["id"] for t in out["items"]] == [1, 2]


def test_page_size_capped_at_100():
    """边界输入：page_size 超过 100 时按 100 处理。"""
    out = list_tickets(TICKETS, page=1, page_size=1000)
    assert out["page_size"] == 100
    assert out["total"] == 4


def test_out_of_range_page_returns_empty():
    """边界输入：页码越界返回空列表，total 仍为筛选后的总数。"""
    out = list_tickets(TICKETS, page=99, page_size=2)
    assert out["items"] == []
    assert out["total"] == 4
````

````python title=tests/test_tickets_task.py
"""本次任务的目标测试（修改前必须失败，修改后必须通过）。

对应任务 T-1042：工单列表增加标签筛选，并修正分页边界输入。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from tickets import list_tickets  # noqa: E402

TICKETS = [
    {"id": 1, "title": "登录页 500", "status": "open", "priority": "P0", "tags": ["auth"]},
    {"id": 2, "title": "导出超时", "status": "open", "priority": "P1", "tags": ["export", "perf"]},
    {"id": 3, "title": "文案错别字", "status": "closed", "priority": "P2", "tags": ["copy"]},
    {"id": 4, "title": "列表卡顿", "status": "open", "priority": "P1", "tags": ["perf"]},
]


def test_filter_by_tag():
    """新增：按标签筛选，只返回 tags 中包含该标签的工单。"""
    out = list_tickets(TICKETS, tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_tag_filter_combines_with_status():
    """标签筛选可与状态筛选叠加。"""
    out = list_tickets(TICKETS, status="open", tag="perf")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_page_zero_normalized_to_first_page():
    """边界输入：page=0 视为第 1 页，返回首页数据而不是空列表。"""
    out = list_tickets(TICKETS, page=0, page_size=2)
    assert out["page"] == 1
    assert [t["id"] for t in out["items"]] == [1, 2]


def test_page_size_capped_at_100():
    """边界输入：page_size 超过 100 时按 100 处理。"""
    out = list_tickets(TICKETS, page=1, page_size=1000)
    assert out["page_size"] == 100
    assert out["total"] == 4


def test_out_of_range_page_returns_empty():
    """边界输入：页码越界返回空列表，total 仍为筛选后的总数。"""
    out = list_tickets(TICKETS, page=99, page_size=2)
    assert out["items"] == []
    assert out["total"] == 4
````

## 输出格式（必须严格遵守，否则无法自动落盘）

每个需要修改的文件输出**一个**代码块，语言标记后面紧跟 `file=` 和相对路径，块内是**修改后的完整文件内容**（用三个反引号，不要用四个）：

````text
```python file=app/tickets.py
# ……这里是修改后的完整文件，不要省略任何原有函数……
```
````

除此之外不要输出其它格式的代码块；不要用 diff、不要只给片段、不要改测试文件。

## 具体要求

1. 只修改 app/tickets.py，输出完整文件内容；
2. 逐条满足规格中的归一化与筛选规则，参数默认值与原实现保持一致；
3. 保持返回结构 {items, page, page_size, total} 不变；
4. 代码块之前可以用一小段文字说明你改了哪几条规格，但不要贴整段代码之外的大段解释。