# MiniMax Agent 回复原文（T-1042）

- 产品/模型：MiniMax Code 网页端（agent.minimax.cn），模型 M3.1-Flash
- 会话链接：https://agent.minimax.cn/mavis?id=463620122608782
- 生成时间：2026-11-15 19:16–19:18（页面显示「共执行 1 分 23 秒」）
- 提示词来源：`evidence/prompt-T-1042.md`（由 seekdb 检索结果拼成，本仓库 `node src/cli.mjs prompt` 生成）

## 模型说明（原文）

改动完成，验证通过。以下是按规格落地后的 app/tickets.py：

实现要点（对应 SPEC-FILTERING v2 / SPEC-PAGINATION v3）

list_tickets 新增 tag 参数，按 tags 数组成员匹配（_has_tag），工单缺 tags 字段或 tags 非序列时视为空数组，不抛异常；与 status / priority 之间为 AND 关系，三者传 None 即不启用该维度。
分页参数归一化：page < 1 → 1、page_size > 100 → 100、page_size < 1 → 20，返回值中的 page / page_size 是归一化后的值；total 为筛选后总数，与分页无关；页码越界时 items 为空列表。
顺序约定：先全部筛选 → 计算 total → 最后切片；保持入参顺序，返回结构仍为 {items, page, page_size, total}。

验证情况（本地等价断言执行，环境无 pytest 且 pypi 不可达，故用自写 runner 跑同样的 test_* 函数）

目标测试 test_tickets_task.py：对着复原的改前版本 4 项失败（tag 关键字未定义、page=0 未归一化、page_size=1000 未截断），改后 5 项全部通过。
回归侧：另写 14 项断言覆盖默认分页、status/priority 单独与组合筛选、顺序保持、四键结构、缺 tags 容错、page_size=0/-5 回退等，改后全部通过（真实回归文件 sample/tests/test_tickets.py 内容未随任务提供，未能直接执行）。

## 模型给出的完整文件

> 页面以「交付物 tickets.py」卡片呈现，正文中未内嵌 `file=` 标记；下方代码块内容为该卡片代码区的原文，仅补上 `file=` 标注以便 `apply` 解析。

```python file=app/tickets.py
"""工单列表服务（业务工程样本，供 SDD 上下文模块演示一次真实代码修改）。"""
from __future__ import annotations

DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def _normalize_page(page):
    """SPEC-PAGINATION：page 从 1 开始，小于 1 一律按 1 处理。"""
    try:
        value = int(page)
    except (TypeError, ValueError):
        return DEFAULT_PAGE
    return value if value >= DEFAULT_PAGE else DEFAULT_PAGE


def _normalize_page_size(page_size):
    """SPEC-PAGINATION：page_size 上限 100，下限 1，非法值回落到默认值 20。"""
    try:
        value = int(page_size)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    if value > MAX_PAGE_SIZE:
        return MAX_PAGE_SIZE
    if value < 1:
        return DEFAULT_PAGE_SIZE
    return value


def _has_tag(ticket, tag):
    """SPEC-FILTERING：标签按成员匹配，工单缺少 tags 字段时视为空数组。"""
    tags = ticket.get("tags")
    if not isinstance(tags, (list, tuple, set, frozenset)):
        return False
    return tag in tags


def list_tickets(tickets, status=None, priority=None, page=1, page_size=20, tag=None):
    """按状态/优先级/标签筛选工单并分页返回。

    SPEC-FILTERING：status / priority / tag 三个维度之间是 AND 关系；
    某维度传 None 表示不启用该维度；工单缺少 tags 字段时按空数组处理。
    SPEC-PAGINATION：page / page_size 先归一化再切片，返回值中的 page 与
    page_size 是归一化之后的值；页码越界时 items 为空列表，
    total 仍是筛选后的总条数。

    tickets: list[dict]，每项含 id / title / status / priority / tags
    返回 dict：{items, page, page_size, total}
    """
    items = list(tickets)
    if status is not None:
        items = [t for t in items if t.get("status") == status]
    if priority is not None:
        items = [t for t in items if t.get("priority") == priority]
    if tag is not None:
        items = [t for t in items if _has_tag(t, tag)]
    page = _normalize_page(page)
    page_size = _normalize_page_size(page_size)
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "items": items[start:end],
        "page": page,
        "page_size": page_size,
        "total": total,
    }
```
