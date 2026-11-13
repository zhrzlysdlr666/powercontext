#!/usr/bin/env python3
"""仓库根入口别名：等价于 `python main.py`。"""
import os, runpy, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.argv = [os.path.join(ROOT, "qoder", "main.py")] + sys.argv[1:]
runpy.run_path(os.path.join(ROOT, "qoder", "main.py"), run_name="__main__")
