#!/usr/bin/env python3
"""一次性核对 StudyLens 的交付物。

    python qoder/verify.py

检查项（全部真连 seekdb，不用 mock）：
  1. seekdb 可连接，且库里已有 13 篇文档 / 84 个切片；
  2. 全文索引存在（FULLTEXT，优先 ik 解析器）；
  3. 6 条样例查询都能用 MATCH ... AGAINST 命中；
  4. 检索写入 query_log，热词能聚合出来；
  5. 作品页产物齐全（检索台标记、首屏预渲染区块、三张截图）。
退出码 0 表示全部通过。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from seekdb_store import SeekdbStore  # noqa: E402

CASES = [
    ("中文分词器怎么选", "建表与全文索引"),
    ("倒排索引", "倒排索引的基本结构"),
    ("报表自动化", "报表"),
    ("项目进度跟踪", "阻塞项"),
    ("文献综述怎么读", "文献综述"),
    ("工作提效", "重复劳动"),
]

failed = 0


def check(name, ok, detail=""):
    global failed
    print(("PASS  " if ok else "FAIL  ") + name + (("  — " + detail) if detail else ""))
    if not ok:
        failed += 1


def main():
    store = SeekdbStore()
    try:
        info = store.prepare()
    except Exception as exc:
        print("FAIL  seekdb 启动 — %s" % exc)
        return 1

    stats = store.stats()
    check("seekdb 连接", stats["ok"], "%s / %s" % (stats["mode"], stats["version"]))
    check("语料已入库", stats["docs"] >= 13 and stats["chunks"] >= 80,
          "%d 切片 / %d 文档（%s）" % (stats["chunks"], stats["docs"], "复用" if info["reused"] else "本次写入"))
    check("全文索引", stats["parser"] in ("ik", "default"), "parser=%s" % stats["parser"])

    ok_cases = 0
    for q, expect in CASES:
        res = store.search(q)
        top = res["hits"][0]["heading"] if res["hits"] else ""
        hit = res["total"] > 0 and any(expect in h["heading"] or expect in h["doc"] for h in res["hits"])
        ok_cases += 1 if hit else 0
        check('MATCH "%s"' % q, hit, "%d 命中 / %.2f ms / top=%s" % (res["total"], res["latencyMs"], top))

    hot = store.hot(5)
    check("检索留痕（query_log）", len(hot) > 0, "热词 %d 个：%s" % (len(hot), ", ".join(h["q"] for h in hot[:3])))

    page = os.path.join(HERE, "web", "index.html")
    html = open(page, encoding="utf-8").read() if os.path.exists(page) else ""
    check("作品页存在", bool(html), "%d 字符" % len(html))
    check("检索台标记", 'id="q"' in html and "<!--B:results-->" in html)
    check("首屏预渲染结果", 'class="card"' in html and 'data-query=' in html)
    check("页面含 seekdb 用法说明", "WITH PARSER ik" in html and "MATCH" in html)
    shots = ["shot-01-search.png", "shot-02-query.png", "shot-03-tech.png"]
    have = [s for s in shots if os.path.exists(os.path.join(HERE, "web", "assets", s))]
    check("截图齐全", len(have) == len(shots), "%d/%d" % (len(have), len(shots)))

    with open(os.path.join(HERE, "web", "data", "live.json"), encoding="utf-8") as fh:
        snap = json.load(fh)
    check("静态快照（Qoder Sites 用）", bool(snap.get("presets")),
          "%d 组查询 / 导出时间 %s" % (len(snap.get("presets") or {}), snap.get("generatedAt")))

    store.close()
    print("\n%d 项检查，%d 项失败" % (10 + len(CASES) + 1, failed))
    print("VERIFY PASS" if not failed else "VERIFY FAILED")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
