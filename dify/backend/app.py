"""赛博说书人 · 检索后端（600076）

职责：Dify 的 HTTP Request 节点调用 `/compose`，从 seekdb 里检索「角色 / 梗 / 道具」，
把 TOP3 素材拼成提示词上下文回给 Dify，同时把这一回合写进 `turns` 表。

两种部署形态，都是真 seekdb：
  1) 嵌入式：pip install pylibseekdb，引擎随包自带，数据落在 SEEKDB_DIR；
  2) 服务端：docker run -p 2881:2881 oceanbase/seekdb，设置 SEEKDB_HOST=127.0.0.1。

所有 SQL 都走 pymysql 参数绑定；Dify 自己的元数据库（PostgreSQL）完全不动。
"""

import json
import os
import re
import threading
import time
from datetime import datetime

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

HERE = os.path.dirname(os.path.abspath(__file__))
DB_NAME = os.environ.get("STORY_DB", "studystory")
SEEKDB_DIR = os.environ.get("SEEKDB_DIR", os.path.join(HERE, "data", "seekdb"))
SEEKDB_HOST = os.environ.get("SEEKDB_HOST", "").strip()
SEEKDB_PORT = int(os.environ.get("SEEKDB_PORT", "2881"))
SEEKDB_USER = os.environ.get("SEEKDB_USER", "root")
SEEKDB_PASSWORD = os.environ.get("SEEKDB_PASSWORD", "")

app = FastAPI(title="CyberStory Retrieval Backend", version="1.0.0")

_lock = threading.Lock()
_state = {"conn": None, "mode": "", "version": "", "parser": "", "instance": None}


# --------------------------------------------------------------------------- 连接
def _connect():
    """返回一个指向业务库的连接；首次调用会建库 + 灌种子数据。"""
    with _lock:
        if _state["conn"] is not None:
            try:
                _state["conn"].ping(reconnect=False)
                return _state["conn"]
            except Exception:
                _state["conn"] = None
        if SEEKDB_HOST:
            _open_mysql(SEEKDB_HOST, SEEKDB_PORT)
            _state["mode"] = "server"
        else:
            _open_embedded()
        _bootstrap()
        return _state["conn"]


def _open_embedded():
    import pylibseekdb as seekdb

    os.makedirs(SEEKDB_DIR, exist_ok=True)
    inst = seekdb.open(db_dir=SEEKDB_DIR)
    opts = inst.connection_options() or {}
    _state["instance"] = inst
    _open_mysql(opts.get("host", "127.0.0.1"), int(opts.get("port", 2881)),
                opts.get("user", "root"), opts.get("password", ""))
    _state["mode"] = "embedded"


def _open_mysql(host, port, user=None, password=None):
    import pymysql

    conn = pymysql.connect(
        host=host, port=int(port), user=user or SEEKDB_USER,
        password=password if password is not None else SEEKDB_PASSWORD,
        autocommit=True, charset="utf8mb4",
    )
    with conn.cursor() as cur:
        cur.execute("SELECT VERSION()")
        _state["version"] = cur.fetchone()[0]
        cur.execute("CREATE DATABASE IF NOT EXISTS `%s`" % DB_NAME)
        cur.execute("USE `%s`" % DB_NAME)
    _state["conn"] = conn
    return conn


def _split_sql(text):
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith("--")]
    out, buf = [], []
    for ln in lines:
        buf.append(ln)
        if ln.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip().rstrip(";").strip()
            if stmt:
                out.append(stmt)
            buf = []
    if "".join(buf).strip():
        out.append("".join(buf).strip())
    return out


def _bootstrap():
    """建表 + 灌种子；索引语句失败时（没有 ik 分词器）自动退化并记录。"""
    conn = _state["conn"]
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES LIKE 'personas'")
        if cur.fetchone():
            _probe_parser(cur)
            return
    with open(os.path.join(HERE, "seed.sql"), encoding="utf-8") as fh:
        stmts = _split_sql(fh.read())
    parser = "default"
    conn = _state["conn"]
    with conn.cursor() as cur:
        for stmt in stmts:
            try:
                cur.execute(stmt)
                if "WITH PARSER ik" in stmt:
                    parser = "ik"
            except Exception as exc:
                if "WITH PARSER ik" in stmt:
                    try:
                        cur.execute(stmt.replace(" WITH PARSER ik", ""))
                        continue
                    except Exception:
                        pass
                raise RuntimeError("执行失败：%s\n%s" % (stmt.splitlines()[0], exc))
    _state["parser"] = parser


def _probe_parser(cur):
    cur.execute("SHOW INDEX FROM personas")
    rows = cur.fetchall()
    _state["parser"] = "ik" if any("ft_personas" in str(r[2]) for r in rows) else "default"
    if not _state["parser"]:
        _state["parser"] = "default"


def _terms(q):
    """整串 + 二元词组：ik 下空格分隔即 OR，整串四字词常整串匹配不到。"""
    q = (q or "").strip()
    keys = [q]
    if len(q) >= 2:
        keys += [q[i:i + 2] for i in range(len(q) - 1)]
    seen, out = set(), []
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out[:6]


SEARCH_SQL = """
SELECT '角色' AS kind, id, name AS title, CONCAT(role, '｜', traits, '｜', catchphrase) AS body,
       MATCH(traits) AGAINST (%s) AS score
FROM personas WHERE MATCH(traits) AGAINST (%s)
UNION ALL
SELECT '梗' AS kind, id, title, body, MATCH(body) AGAINST (%s) AS score
FROM memes WHERE MATCH(body) AGAINST (%s)
UNION ALL
SELECT '道具' AS kind, id, name, effect, MATCH(effect) AGAINST (%s) AS score
FROM props WHERE MATCH(effect) AGAINST (%s)
ORDER BY score DESC LIMIT %s
"""


def search(q, topk=3):
    started = time.perf_counter()
    expr = " ".join(_terms(q))
    conn = _connect()
    rows, stage = [], "match"
    with conn.cursor() as cur:
        args = []
        for _ in range(3):
            args += [expr, expr]
        args.append(int(topk))
        try:
            cur.execute(SEARCH_SQL, args)
            rows = list(cur.fetchall())
        except Exception:
            stage = "like"
            like = "%" + q + "%"
            cur.execute(
                "SELECT '角色' kind, id, name title, CONCAT(role,'｜',traits) body, 0 score "
                "FROM personas WHERE traits LIKE %s OR name LIKE %s "
                "UNION ALL SELECT '梗', id, title, body, 0 FROM memes WHERE body LIKE %s OR title LIKE %s "
                "UNION ALL SELECT '道具', id, name, effect, 0 FROM props WHERE effect LIKE %s OR name LIKE %s "
                "LIMIT %s",
                [like, like, like, like, like, like, int(topk)],
            )
            rows = list(cur.fetchall())
    hits = [
        {"kind": r[0], "id": r[1], "title": r[2], "body": r[3][:220], "score": round(float(r[4]), 4)}
        for r in rows
    ]
    ms = round((time.perf_counter() - started) * 1000, 2)
    return {"expr": expr, "stage": stage, "latencyMs": ms, "hits": hits}


def build_context(hits):
    if not hits:
        return "（本次没有命中任何素材，请凭想象力编一个）"
    lines = ["【seekdb 检索到的素材 TOP%d】" % len(hits)]
    for i, h in enumerate(hits, 1):
        lines.append("%d. [%s] %s：%s" % (i, h["kind"], h["title"], h["body"]))
    return "\n".join(lines)


# --------------------------------------------------------------------------- 接口
@app.get("/health")
def health():
    conn = _connect()
    with conn.cursor() as cur:
        counts = {}
        for table in ("personas", "memes", "props", "turns"):
            cur.execute("SELECT COUNT(*) FROM `%s`" % table)
            counts[table] = int(cur.fetchone()[0])
    return {
        "ok": True,
        "engine": "seekdb",
        "mode": _state["mode"],
        "version": _state["version"],
        "parser": _state["parser"],
        "database": DB_NAME,
        "tables": counts,
    }


@app.get("/search")
def api_search(q: str = Query(..., min_length=1), topk: int = 3):
    result = search(q, topk)
    result.update({"engine": "seekdb", "parser": _state["parser"]})
    return result


@app.get("/compose")
def api_compose(q: str = Query(..., min_length=1), session_id: str = "dify"):
    """GET 版本，方便 Dify 的 HTTP 节点直接用 query 传参。"""
    return compose(q, session_id)


@app.post("/compose")
def api_compose_post(payload: dict = None):
    payload = payload or {}
    return compose(str(payload.get("input") or payload.get("q") or ""), str(payload.get("session_id") or "dify"))


def compose(text, session_id):
    text = (text or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "input 不能为空"}, status_code=400)
    result = search(text, 3)
    context = build_context(result["hits"])
    conn = _connect()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO turns (session_id, input, hits, context, created_at) VALUES (%s,%s,%s,%s,%s)",
            (session_id[:64], text[:300], json.dumps(result["hits"], ensure_ascii=False), context[:4000], now),
        )
        turn_id = cur.lastrowid
    return {
        "ok": True,
        "turnId": turn_id,
        "engine": "seekdb",
        "parser": _state["parser"],
        "stage": result["stage"],
        "latencyMs": result["latencyMs"],
        "hits": result["hits"],
        "context": context,
        "written": {"table": "turns", "id": turn_id, "at": now},
    }


@app.get("/turns")
def api_turns(limit: int = 5):
    conn = _connect()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, session_id, input, created_at FROM turns ORDER BY id DESC LIMIT %s", (int(limit),)
        )
        rows = cur.fetchall()
    return {"ok": True, "rows": [
        {"id": r[0], "session": r[1], "input": r[2], "createdAt": str(r[3])} for r in rows
    ]}


@app.get("/stats")
def api_stats():
    conn = _connect()
    out = {}
    with conn.cursor() as cur:
        for table in ("personas", "memes", "props", "turns"):
            cur.execute("SELECT COUNT(*) FROM `%s`" % table)
            out[table] = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(DISTINCT session_id) FROM turns")
        sessions = int(cur.fetchone()[0])
    return {"ok": True, "engine": "seekdb", "mode": _state["mode"], "parser": _state["parser"],
            "rows": out, "sessions": sessions}


@app.post("/seed")
def api_seed(force: bool = False):
    """重新灌种子（默认只在空库时执行）。"""
    conn = _connect()
    if force:
        with conn.cursor() as cur:
            for table in ("turns", "personas", "memes", "props"):
                cur.execute("DROP TABLE IF EXISTS `%s`" % table)
        _bootstrap()
    return health()


@app.get("/debug", response_class=None)
def api_debug(q: str = Query(None)):
    """一页看完：库版本、四张表行数、真实 MATCH 命中、最近写入的回合。给人看/截图用。"""
    from fastapi.responses import HTMLResponse

    conn = _connect()
    h = health()
    result = search(q, 3) if q else None
    with conn.cursor() as cur:
        cur.execute("SELECT id, session_id, input, created_at FROM turns ORDER BY id DESC LIMIT 5")
        recent = cur.fetchall()
    rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % tuple(r) for r in recent
    ) or "<tr><td colspan=4>（还没有回合）</td></tr>"
    hits = ""
    if result:
        hits = "<table><tr><th>kind</th><th>title</th><th>score</th><th>body</th></tr>" + "".join(
            "<tr><td>%s</td><td>%s</td><td>%.4f</td><td>%s</td></tr>" % (x["kind"], x["title"], x["score"], x["body"])
            for x in result["hits"]
        ) + "</table><p class=dim>expr=<code>%s</code> stage=%s latency=%sms hits=%d</p>" % (
            result["expr"], result["stage"], result["latencyMs"], len(result["hits"]))
    html = """<!doctype html><html lang=zh-CN><meta charset=utf-8><title>CyberStory · seekdb 证据页</title>
<style>body{font:14px/1.6 -apple-system,"Segoe UI","PingFang SC",sans-serif;background:#f7f8fa;color:#16202c;margin:0;padding:28px}
.wrap{max-width:960px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;color:#0b6b5f}
table{border-collapse:collapse;width:100%%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06)}
th,td{border:1px solid #e3e7ee;padding:6px 9px;text-align:left;vertical-align:top;font-size:13px}
th{background:#eef4f2;font-weight:600}.dim{color:#65717f;font-size:12px}.k{color:#0b6b5f;font-weight:600}code{background:#eef4f2;padding:1px 5px;border-radius:4px}</style>
<div class=wrap><h1>赛博说书人 · seekdb 实测证据</h1>
<p class=dim>engine=<span class=k>%(engine)s</span> mode=%(mode)s version=%(version)s parser=<span class=k>%(parser)s</span> db=%(db)s</p>
<h2>四张业务表行数</h2><table><tr><th>表</th><th>行数</th></tr>%(tables)s</table>
<h2>全文检索 MATCH ... AGAINST（q=%(q)s）</h2>%(hits)s
<h2>turns 最近 5 条（写入证据）</h2><table><tr><th>id</th><th>session</th><th>input</th><th>created_at</th></tr>%(rows)s</table>
<p class=dim>本页由 dify/backend/app.py 现场查询 seekdb 生成，不是静态文件。</p></div></html>""" % {
        "engine": h["engine"], "mode": h["mode"], "version": h["version"], "parser": h["parser"],
        "db": h["database"],
        "tables": "".join("<tr><td>%s</td><td class=k>%d</td></tr>" % (k, v) for k, v in h["tables"].items()),
        "q": q or "（未传 q）", "hits": hits, "rows": rows,
    }
    return HTMLResponse(html)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8181"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
