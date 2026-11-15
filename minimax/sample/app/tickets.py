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
