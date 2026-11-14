#!/bin/sh
# 仓库根入口（零依赖，不需要 npm install / pip install）
#   ./run.sh            自检：打印 SELFCHECK PASS，退出码 0
#   ./run.sh --serve    起服务：http://127.0.0.1:8899/
# 依次尝试 python3 / python / node，任一可用即可运行；都没有时给出可直接打开的文件路径。
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  exec python3 main.py "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python main.py "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node main.mjs "$@"
fi

echo "未找到 python3 / python / node。页面本身是静态的，可直接用浏览器打开：" >&2
echo "  file://$PWD/qoder/web/index.html" >&2
exit 1
