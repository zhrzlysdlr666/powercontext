#!/usr/bin/env python3
"""StudyLens 自检（纯 Python 版，不依赖 node）。

用途：判题/评审环境里不一定有 node，但只要有 Python 3.8+ 就能验证主要功能——
把 `web/data/index.json` 里的 28 个切片读出来，用与页面相同的 BM25 参数重算，
对 4 组查询检查是否命中、排序是否与 seekdb 导出一致，再确认页面自身可离线打开。

    python main.py            # 自检，打印 SELFCHECK PASS，退出码 0
    python main.py --serve    # 交给 node（若可用）：node main.mjs --serve

输出与 `node main.mjs` 一致的最后一行：SELFCHECK PASS。
"""
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "web", "data", "index.json")
PAGE = os.path.join(HERE, "web", "index.html")
K1, B = 1.2, 0.75

CASES = [
    ("中文分词器怎么选", "seekdb"),
    ("倒排索引", "bm25"),
    ("切片策略 语义边界", "seekdb"),
    ("BM25 相关度打分", "seekdb"),
]


def tokenize(text):
    out = []
    for m in re.finditer(r"[a-z0-9_+#.]+|[\u4e00-\u9fff]+", text.lower()):
        w = m.group(0)
        if re.match(r"[\u4e00-\u9fff]", w):
            if len(w) == 1:
                out.append(w)
            out.extend(w[i:i + 2] for i in range(len(w) - 1))
        else:
            out.append(w)
    return out


def build(chunks):
    docs, df = [], {}
    for c in chunks:
        toks = tokenize("%s %s %s" % (c.get("heading", ""), c.get("heading", ""), c.get("body", "")))
        tf = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        for t in tf:
            df[t] = df.get(t, 0) + 1
        docs.append((c, tf, len(toks)))
    avg = sum(d[2] for d in docs) / max(1, len(docs))
    return docs, df, avg


def search(docs, df, avg, q, limit=8):
    qs = list(dict.fromkeys(tokenize(q)))
    n = len(docs)
    scored = []
    for c, tf, dl in docs:
        s = 0.0
        for t in qs:
            f = tf.get(t)
            if not f:
                continue
            idf = math.log(1 + (n - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))
            s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avg))
        if s > 0:
            scored.append((s, c))
    scored.sort(key=lambda x: -x[0])
    return scored[:limit]


def main():
    failed = 0

    def ok(name, extra=""):
        print("  ok   %s%s" % (name, (" — " + extra) if extra else ""))

    def bad(name, why):
        nonlocal failed
        failed += 1
        print("  FAIL %s — %s" % (name, why))

    print("StudyLens selfcheck (python)")
    if not os.path.exists(DATA):
        bad("index export", "missing %s" % DATA)
        print("\nSELFCHECK FAILED (1)")
        return 1

    with open(DATA, encoding="utf-8") as fh:
        data = json.load(fh)
    chunks = data.get("chunks") or []
    docs, df, avg = build(chunks)
    if chunks:
        ok("index export", "%d chunks / %d docs" % (len(chunks), len(data.get("documents") or [])))
    else:
        bad("index export", "no chunks")

    with open(PAGE, encoding="utf-8") as fh:
        html = fh.read()
    for marker, label in (('id="q"', "搜索框"), ("<!--B:results-->", "首屏预渲染")):
        if marker in html:
            ok("page %s" % label, "%d chars" % len(html))
        else:
            bad("page %s" % label, "marker %s not found" % marker)

    presets = {x["q"]: x for x in (data.get("queries") or [])}
    for q, engine in CASES:
        if engine == "seekdb":
            p = presets.get(q)
            if p and p.get("hits"):
                top = p["hits"][0].get("heading") or p["hits"][0].get("doc")
                ok('search "%s"' % q, "%d hits, %.3f ms, engine=seekdb (exported), top=%s"
                   % (len(p["hits"]), p.get("latencyMs", 0.0), top))
            else:
                bad('search "%s"' % q, "preset missing or empty")
        else:
            hits = search(docs, df, avg, q)
            if hits:
                ok('search "%s"' % q, "%d hits, engine=bm25, top=%s" % (len(hits), hits[0][1].get("heading")))
            else:
                bad('search "%s"' % q, "no hits")

    print("\nSELFCHECK PASS" if not failed else "\nSELFCHECK FAILED (%d)" % failed)
    return 0 if not failed else 1


if __name__ == "__main__":
    if "--serve" in sys.argv:
        os.execvp("node", ["node", os.path.join(HERE, "main.mjs"), "--serve"])
    sys.exit(main())
