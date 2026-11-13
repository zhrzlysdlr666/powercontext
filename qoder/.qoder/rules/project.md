# project rules

- 只用标准库实现 Python 侧入口（main.py / app.py / run.py / run.sh），保证 `python main.py` 在无网络、
  无第三方包的环境里也能跑出 `SELFCHECK PASS`、退出码 0。
- Node 侧入口（main.mjs / src/serve.mjs）同样零依赖；`npm install` 只用于可选的重新索引。
- 页面首屏不依赖网络请求：索引内联，`file://` 可用。
- 每次改动后同步 `验证样例.md` 的预期输出，并重跑 `docs/smoke_results.json` 采集。
