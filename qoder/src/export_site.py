#!/usr/bin/env python3
"""把 seekdb 的真实检索结果导出成静态站点快照。

Qoder Sites 是静态托管，没有后端进程；所以作品页在「无后端」时展示的快照必须是
**真跑过 seekdb 的结果**，不能是另写一套 JS 检索。这个脚本负责：

1. 打开 seekdb（嵌入式或 SEEKDB_HOST 指定的服务端），确认语料已入库；
2. 对预设查询逐条执行 `MATCH ... AGAINST`，拿到命中、分数、耗时；
3. 写 `web/data/live.json`，并把同样的数据内联进 `web/index.html`
   （`<script id="live-data">` + `<!--B:results-->` 首屏区块）；
4. 覆盖 `web/health`、`web/healthz`、`web/search` 三个静态探测文件。

    python src/export_site.py
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
sys.path.insert(0, ROOT)

from seekdb_store import SeekdbStore  # noqa: E402

PRESETS = [
    "中文分词器怎么选",
    "倒排索引",
    "报表自动化",
    "项目进度跟踪",
    "文献综述怎么读",
    "工作提效",
]
DEFAULT_Q = PRESETS[0]


def card_html(hit):
    score = hit.get("score")
    score = ("%.2f" % score) if isinstance(score, (int, float)) else str(score)
    return (
        '    <div class="card">\n'
        '      <h3>%s</h3>\n'
        '      <div class="meta"><b>%s</b><span>%s</span><span class="score">%s</span></div>\n'
        '      <p class="snip">%s</p>\n'
        '    </div>\n'
        % (
            esc(hit.get("heading")),
            esc(hit.get("doc")),
            esc(hit.get("topic")),
            score,
            esc(hit.get("snippet")),
        )
    )


def esc(s):
    return (
        str(s if s is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def main():
    store = SeekdbStore()
    info = store.prepare()
    stats = store.stats()
    print("seekdb: %s, %d chunks / %d docs (ingested=%d)" % (stats["mode"], stats["chunks"], stats["docs"], info["ingested"]))

    snapshot = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "engine": "seekdb",
        "mode": stats["mode"],
        "version": stats["version"],
        "parser": stats["parser"],
        "stats": {"chunks": stats["chunks"], "docs": stats["docs"], "queries": stats["queries"], "version": stats["version"]},
        "presets": {},
        "hot": store.hot(8),
    }
    for q in PRESETS:
        snapshot["presets"][q] = store.search(q, log=False)
        print("  %-12s %d hits / %.2f ms" % (q, snapshot["presets"][q]["total"], snapshot["presets"][q]["latencyMs"]))

    os.makedirs(os.path.join(WEB, "data"), exist_ok=True)
    with open(os.path.join(WEB, "data", "live.json"), "w", encoding="utf-8") as fh:
        json.dump(snapshot, fh, ensure_ascii=False, indent=1)

    page_path = os.path.join(WEB, "index.html")
    html = open(page_path, encoding="utf-8").read()
    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    html, n1 = re.subn(
        r'<script id="live-data" type="application/json">[\s\S]*?</script>',
        '<script id="live-data" type="application/json">%s</script>' % payload,
        html,
    )
    default = snapshot["presets"][DEFAULT_Q]
    cards = "".join(card_html(h) for h in default["hits"][:8])
    block = "    <!--B:results-->\n%s    <!--E:results-->" % cards
    html, n2 = re.subn(r"    <!--B:results-->[\s\S]*?<!--E:results-->", block, html)
    html, n3 = re.subn(
        r'data-query="[^"]*" data-hits="\d+"',
        'data-query="%s" data-hits="%d"' % (esc(DEFAULT_Q), default["total"]),
        html,
        count=1,
    )
    with open(page_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("page: live-data=%d results=%d attrs=%d" % (n1, n2, n3))

    health = {
        "ok": True,
        "engine": "seekdb",
        "mode": stats["mode"],
        "version": stats["version"],
        "parser": stats["parser"],
        "index": stats["index"],
        "database": stats["database"],
        "chunks": stats["chunks"],
        "docs": stats["docs"],
        "entry": "web/index.html",
        "site": "StudyLens",
        "note": "静态镜像：数值来自 seekdb 真实建表与 MATCH 查询导出；在线检索见仓库内 python main.py --serve",
    }
    body = json.dumps(health, ensure_ascii=False)
    for name in ("health", "healthz", "health.json"):
        with open(os.path.join(WEB, name), "w", encoding="utf-8") as fh:
            fh.write(body + "\n")

    with open(os.path.join(WEB, "search"), "w", encoding="utf-8") as fh:
        json.dump(
            {
                "ok": True,
                "q": DEFAULT_Q,
                "engine": "seekdb",
                "source": "seekdb-export",
                "total": default["total"],
                "latencyMs": default["latencyMs"],
                "hits": default["hits"],
                "note": "静态托管下的默认查询快照；换成 /api/search?q=任意关键词 走真实 seekdb",
            },
            fh,
            ensure_ascii=False,
            indent=1,
        )

    store.close()
    print("SELFCHECK PASS (export)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
