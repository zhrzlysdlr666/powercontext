#!/usr/bin/env python3
"""兼容入口：等价于 `python main.py`（自检）或 `python main.py --serve`（服务）。"""
import runpy
import sys

runpy.run_path(__file__.replace("app.py", "main.py"), run_name="__main__")
