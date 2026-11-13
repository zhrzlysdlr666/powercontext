"""工单列表服务的既有测试（回归基线）。

这些测试在修改前后都必须通过，用来证明新增筛选与分页边界修复没有破坏原有行为。
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

from tickets import list_tickets  # noqa: E402

TICKETS = [
    {"id": 1, "title": "登录页 500", "status": "open", "priority": "P0", "tags": ["auth"]},
    {"id": 2, "title": "导出超时", "status": "open", "priority": "P1", "tags": ["export", "perf"]},
    {"id": 3, "title": "文案错别字", "status": "closed", "priority": "P2", "tags": ["copy"]},
    {"id": 4, "title": "列表卡顿", "status": "open", "priority": "P1", "tags": ["perf"]},
]


def test_no_filter_returns_first_page():
    out = list_tickets(TICKETS, page=1, page_size=2)
    assert out["total"] == 4
    assert [t["id"] for t in out["items"]] == [1, 2]
    assert out["page"] == 1


def test_filter_by_status():
    out = list_tickets(TICKETS, status="open")
    assert out["total"] == 3
    assert all(t["status"] == "open" for t in out["items"])


def test_filter_by_priority():
    out = list_tickets(TICKETS, priority="P1")
    assert [t["id"] for t in out["items"]] == [2, 4]


def test_second_page():
    out = list_tickets(TICKETS, page=2, page_size=2)
    assert [t["id"] for t in out["items"]] == [3, 4]
