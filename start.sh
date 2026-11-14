#!/bin/sh
# 一键起服务（仓库根）：安装 seekdb 客户端 -> 建库灌语料 -> 监听 8899/3000/8000/5000/8080
#
#   ./start.sh              起服务（默认 8899，同时兜底 3000/8000/5000/8080）
#   ./start.sh --check      只做自检，打印 SELFCHECK PASS 后退出
#
# 依赖已经装好时不会联网；缺依赖才会尝试 pip install。
# 选解释器的规则：优先选已经装好 pylibseekdb 的那个（嵌入式引擎对 Python
# 版本有要求，官方轮子在 3.12 上最稳），没有就退回任意 python 再去装依赖。
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
  echo "未找到 Python。StudyLens 的检索跑在 seekdb 上，需要 Python 3.8+（推荐 3.12）。" >&2
  exit 127
fi
echo "[start.sh] 使用解释器：$PY ($("$PY" -V 2>&1))"

if ! "$PY" -c "import pylibseekdb, pymysql" >/dev/null 2>&1; then
  echo "[start.sh] 缺少 seekdb 客户端，执行 pip install -r requirements.txt ..." >&2
  "$PY" -m pip install --quiet --disable-pip-version-check --retries 1 --timeout 30 -r requirements.txt || {
    echo "[start.sh] 依赖安装失败。离线环境请预装：pip install pylibseekdb pymysql" >&2
    echo "[start.sh] 或改用服务端模式：export SEEKDB_HOST=127.0.0.1 SEEKDB_PORT=2881" >&2
    exit 1
  }
fi

exec "$PY" qoder/main.py "$@"
