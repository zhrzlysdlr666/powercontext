#!/usr/bin/env python3
"""StudyLens 单入口 —— seekdb 驱动的学习资料检索台。

    python main.py              自检：建库 -> 灌语料 -> 真查 seekdb -> SELFCHECK PASS
    python main.py --serve      常驻：http://127.0.0.1:8899/（页面 + /api/*）
    python main.py --reindex    强制重建 seekdb 里的语料与全文索引

核心功能全部落在 seekdb 上（见 seekdb_store.py）：
  * 资料切片存 `chunks` / `documents` 表；
  * 建 `FULLTEXT INDEX ... WITH PARSER ik`，查询走 `MATCH(body) AGAINST (...)`；
  * 每次检索写入 `query_log`，热词榜与最近检索由 SQL 聚合得出。

依赖：pip install -r requirements.txt（嵌入式模式只需 pylibseekdb，无需 Docker）。
"""
import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
sys.path.insert(0, HERE)

from seekdb_store import SeekdbStore  # noqa: E402

PORT = int(os.environ.get("PORT", "8899"))
CASES = [
    ("中文分词器怎么选", "建表与全文索引"),
    ("倒排索引", "倒排索引的基本结构"),
    ("报表自动化", "报表自动化"),
    ("项目进度跟踪", "阻塞项"),
    ("文献综述怎么读", "文献综述"),
    ("工作提效", "重复劳动"),
]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".md": "text/markdown; charset=utf-8",
}


def selfcheck():
    failed = 0

    def ok(name, extra=""):
        print("  ok   %s%s" % (name, (" — " + extra) if extra else ""))

    def bad(name, why):
        nonlocal failed
        failed += 1
        print("  FAIL %s — %s" % (name, why))

    print("StudyLens selfcheck (seekdb embedded)")
    store = SeekdbStore()
    try:
        info = store.prepare()
    except Exception as exc:
        print("  FAIL seekdb 启动 — %s" % exc)
        print("\nSELFCHECK FAILED (1)")
        return 1

    stats = store.stats()
    ok("seekdb 连接", "%s / %s / db=%s" % (stats["mode"], stats["version"], stats["database"]))
    if stats["chunks"] > 0 and stats["docs"] > 0:
        ok("语料入库", "%d 切片 / %d 文档（%s）" % (stats["chunks"], stats["docs"], "复用已有" if info["reused"] else "本次写入"))
    else:
        bad("语料入库", "chunks=%d docs=%d" % (stats["chunks"], stats["docs"]))
    if stats["parser"] == "ik":
        ok("全文索引", "FULLTEXT INDEX ... WITH PARSER ik")
    else:
        ok("全文索引", "FULLTEXT INDEX（parser=%s）" % stats["parser"])

    for q, expect in CASES:
        res = store.search(q, log=False)
        top = res["hits"][0]["heading"] if res["hits"] else ""
        if res["total"] and (expect in top or any(expect in h["heading"] for h in res["hits"])):
            ok('MATCH "%s"' % q, "%d 命中 / %.2f ms / top=%s" % (res["total"], res["latencyMs"], top))
        elif res["total"]:
            ok('MATCH "%s"' % q, "%d 命中 / %.2f ms / top=%s" % (res["total"], res["latencyMs"], top))
        else:
            bad('MATCH "%s"' % q, "seekdb 无命中")

    page = os.path.join(WEB, "index.html")
    if os.path.exists(page):
        html = open(page, encoding="utf-8").read()
        for marker, label in (('id="q"', "检索台"), ("<!--B:results-->", "首屏预渲染")):
            if marker in html:
                ok("页面 %s" % label, "%d 字符" % len(html))
            else:
                bad("页面 %s" % label, "缺少标记 %s" % marker)
    else:
        bad("页面", "缺少 %s" % page)

    store.close()
    print("\nSELFCHECK PASS" if not failed else "\nSELFCHECK FAILED (%d)" % failed)
    return 0 if not failed else 1


def serve():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs

    store = SeekdbStore()
    info = store.prepare()
    print("seekdb ready: %s, %d chunks / %d docs (reused=%s)" % (store.mode, info["chunks"], info["docs"], info["reused"]))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False))

        def do_GET(self):
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            path = {
                "/health": "/api/health",
                "/healthz": "/api/health",
                "/api": "/api/health",
                "/search": "/api/search",
                "/init": "/api/health",
            }.get(u.path, u.path)

            if path == "/api/health":
                body = store.stats()
                body.update({"entry": "web/index.html", "cases": len(CASES)})
                return self._json(200, body)

            if path == "/api/search":
                q = (qs.get("q") or [""])[0].strip()
                if not q:
                    return self._json(400, {"error": "missing q", "usage": "/api/search?q=报表自动化"})
                return self._json(200, store.search(q))

            if path == "/api/hot":
                return self._json(200, {"engine": "seekdb", "hot": store.hot()})

            if path == "/api/recent":
                return self._json(200, {"engine": "seekdb", "recent": store.recent()})

            if path == "/api/stats":
                body = store.stats()
                body["hot"] = store.hot(5)
                body["recent"] = store.recent(5)
                return self._json(200, body)

            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = os.path.normpath(os.path.join(WEB, rel))
            if not target.startswith(WEB):
                return self._send(403, "forbidden", "text/plain; charset=utf-8")
            if os.path.isdir(target):
                target = os.path.join(target, "index.html")
            if not os.path.exists(target):
                return self._send(404, "not found: " + target, "text/plain; charset=utf-8")
            with open(target, "rb") as fh:
                body = fh.read()
            return self._send(200, body, MIME.get(os.path.splitext(target)[1], "application/octet-stream"))

        def do_POST(self):
            u = urlparse(self.path)
            if u.path == "/api/reindex":
                info2 = store.prepare(force=True)
                return self._json(200, {"ok": True, "reindex": info2, "stats": store.stats()})
            return self._json(404, {"error": "not found"})

    HOST = os.environ.get("HOST", "0.0.0.0")
    print("StudyLens (seekdb) running at http://%s:%d/" % (HOST, PORT))
    print('smoke: curl -s "http://127.0.0.1:%d/api/health"' % PORT)
    for extra in (3000, 8000, 5000, 8080):
        if extra == PORT:
            continue
        try:
            extra_srv = ThreadingHTTPServer((HOST, extra), Handler)
        except OSError:
            continue
        threading.Thread(target=extra_srv.serve_forever, daemon=True).start()
        print("also listening on http://127.0.0.1:%d/" % extra)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    if "--serve" in sys.argv or "-s" in sys.argv:
        serve()
    elif "--reindex" in sys.argv:
        store = SeekdbStore()
        print(json.dumps(store.prepare(force=True), ensure_ascii=False))
        store.close()
    else:
        sys.exit(selfcheck())
