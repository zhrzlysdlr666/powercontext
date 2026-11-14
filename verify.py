"""仓库根的一次性核对入口：转发到 qoder/verify.py（真连 seekdb）。"""

import os
import runpy
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(ROOT, "qoder", "verify.py")

if __name__ == "__main__":
    if not os.path.exists(TARGET):
        print("缺少 %s" % TARGET)
        sys.exit(2)
    sys.argv = [TARGET] + sys.argv[1:]
    runpy.run_path(TARGET, run_name="__main__")
