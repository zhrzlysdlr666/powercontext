#!/usr/bin/env python3
"""兼容入口：`python run.py` 自检；`python run.py --serve` 起服务。"""
import runpy

runpy.run_path(__file__.replace("run.py", "main.py"), run_name="__main__")
