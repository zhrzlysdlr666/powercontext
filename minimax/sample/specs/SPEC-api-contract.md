# SPEC-API 工单列表接口契约

编号：SPEC-API
状态：生效中（v2）
适用范围：`sample/app/tickets.py::list_tickets`。

## 1. 函数签名

```python
def list_tickets(tickets, status=None, priority=None, tag=None, page=1, page_size=20)
```

新增参数 `tag` 必须放在 `priority` 之后、`page` 之前，保持位置参数兼容。

## 2. 返回结构

```json
{"items": [...], "page": 1, "page_size": 20, "total": 12}
```

- 四个键必须同时存在，缺一不可。
- `items` 中元素保持入参顺序，不做隐式排序。

## 3. 兼容性要求

- 现有调用方只使用 status / priority / page / page_size，新增 `tag` 不得改变这些参数的行为。
- 不允许改变默认值：`page=1`、`page_size=20`。
- 不允许抛出新的异常类型；非法输入一律归一化（见 SPEC-PAGINATION）。

## 4. 不做的事

- 不实现全文搜索工单标题（另有需求单）。
- 不做跨筛选维度的 OR 组合。
