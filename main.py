#!/usr/bin/env python3
"""仓库根入口：等价于 `cd qoder && python main.py`。

    python main.py            自检（SELFCHECK PASS，退出码 0，约 1 秒）
    python main.py --serve    http://127.0.0.1:8899/
"""
import os
import runpy
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.argv = [os.path.join(ROOT, "qoder", "main.py")] + sys.argv[1:]
runpy.run_path(os.path.join(ROOT, "qoder", "main.py"), run_name="__main__")
