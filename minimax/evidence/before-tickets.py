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
