#!/bin/sh
# 仓库根入口：等价于 cd qoder && python main.py
#
#   ./run.sh            自检：真连 seekdb 跑 6 条查询，打印 SELFCHECK PASS，退出码 0
#   ./run.sh --serve    起服务：http://127.0.0.1:8899/（同时兜底 3000/8000/5000/8080）
#
# 依赖只有 seekdb 客户端两个包（pylibseekdb + pymysql），没有 Web 框架、没有第三方检索库；
# 缺依赖时这里会先 pip install -r requirements.txt，已装好则完全不联网。
set -e
cd "$(dirname "$0")" || exit 1

CANDIDATES="python3.12 python3.11 python3 python"
PY=""
FALLBACK=""
for c in $CANDIDATES; do
  command -v "$c" >/dev/null 2>&1 || continue
  [ -n "$FALLBACK" ] || FALLBACK="$c"
  if "$c" -c "import pylibseekdb, pymysql" >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
[ -n "$PY" ] || PY="$FALLBACK"

if [ -z "$PY" ]; then
  if command -v node >/dev/null 2>&1; then
    exec node main.mjs "$@"
  fi
  echo "未找到 python3 / node。StudyLens 的检索跑在 seekdb 上，需要 Python 3.8+（推荐 3.12）。" >&2
  exit 1
fi

if ! "$PY" -c "import pylibseekdb, pymysql" >/dev/null 2>&1; then
  echo "[run.sh] 缺少 seekdb 客户端，执行 pip install -r requirements.txt ..." >&2
  "$PY" -m pip install --quiet --disable-pip-version-check --retries 1 --timeout 30 -r requirements.txt || {
    echo "[run.sh] 依赖安装失败。离线环境请预装：pip install pylibseekdb pymysql" >&2
    exit 1
  }
fi

exec "$PY" main.py "$@"
