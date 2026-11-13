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
