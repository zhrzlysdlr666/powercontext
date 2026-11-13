"""One-shot check for the Qoder submission: does the page carry the data, the
prerendered first screen and a reachable public URL?

    python verify.py

Zero dependencies; works on Windows and Linux.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "qoder" / "web" / "index.html"
DATA = ROOT / "qoder" / "web" / "data" / "index.json"
LIVE = "https://studylens-lqny1ayu3yc.qoder.zone"

checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail else ""))


def main():
    html = PAGE.read_text(encoding="utf-8")
    data = json.loads(DATA.read_text(encoding="utf-8"))

    m = re.search(r'<script id="index-data" type="application/json">(.*?)</script>', html, re.S)
    check("index.json 已内联到页面", bool(m), "%d 字节" % (len(m.group(1)) if m else 0))
    if m:
        inline = json.loads(m.group(1).replace("<\\/", "</"))
        check("内联数据可解析", len(inline.get("chunks", [])) > 0,
              "%d 切片 / %d 文档" % (len(inline.get("chunks", [])), len(inline.get("documents", []))))

    cards = len(re.findall(r'<div class="card">', html))
    bench = len(re.findall(r"<tr>", html))
    check("首屏预渲染了结果卡片", cards >= 3, "%d 张" % cards)
    check("预渲染了基准表", bench >= 10, "%d 行 <tr>" % bench)
    check("页面引用了 BM25 排序", "BM25" in html)
    block = re.search(r"<!--B:results-->([\s\S]*?)<!--E:results-->", html)
    check("结果区块不是空的（禁用 JS 也有内容）", bool(block) and "card" in block.group(1),
          "%d 字符" % (len(block.group(1)) if block else 0))

    try:
        with urllib.request.urlopen(LIVE, timeout=25) as r:
            body = r.read()
        check("线上站点可访问", r.status == 200, "HTTP %d, %d 字节" % (r.status, len(body)))
        text = body.decode("utf-8", "replace")
        check("线上可见文本含检索结果", "建表与全文索引" in text)
    except Exception as exc:
        check("线上站点可访问", False, str(exc)[:80])

    failed = [c for c in checks if not c[1]]
    print("\n%d checks, %d failed" % (len(checks), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
