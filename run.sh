#!/bin/sh
# 仓库根入口：自检 ./run.sh    服务 ./run.sh --serve
cd "$(dirname "$0")" || exit 1
exec python3 main.py "$@"
