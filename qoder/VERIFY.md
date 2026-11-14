# 验证样例（可逐步执行）

中文详版见 [验证样例.md](./验证样例.md)，这里给出评审可直接照着做的三步。

## 前置

无需安装任何依赖；无需 seekdb 运行时（索引已随仓库导出）。

## 样例 1：命令自检（约 1 秒，退出码 0）

```bash
python main.py          # 或 python3 main.py / node main.mjs / ./run.sh
```

预期输出（末尾）：

```
  ok   index chunks = 28
  ok   search "倒排索引"  — 8 hits, ...
  ok   search "BM25 相关度打分" — 6 hits, ...
SELFCHECK PASS
```

对照点：`SELFCHECK PASS` + 退出码 0；每组查询的命中数来自 `web/data/index.json`（seekdb 导出）。

## 样例 2：起服务后调接口

```bash
python main.py --serve &            # http://127.0.0.1:8899/
curl -s localhost:8899/api/health
curl -s "localhost:8899/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"
```

预期：health 返回 `{"ok":true,"engine":"seekdb ...","chunks":28,"docs":5,"presets":12}`；
search 返回 8 条命中，第一条是「倒排索引的基本结构」，分数 10.345。

## 样例 3：网页体验（线上，无需登录）

打开 https://studylens-lqny1ayu3yc.qoder.zone

- 首屏默认展示预置查询「中文分词器怎么选」：4 条命中，耗时 0.761 ms（seekdb 实测）；
- 在搜索框输入「倒排索引」：立即出 8 条，带分数与耗时；回车或点「检索」等同效；
- 也可直接用深链：`?q=倒排索引` 带参打开，页面加载即渲染结果；
- 下方「预置查询基准」表格是 12 组查询的 seekdb 实测延迟。

## 样例 4：seekdb 是否真的在起作用（可选，需装 seekdb 依赖）

```bash
cd qoder && npm install @oceanbase/seekdb-node mysql2
node src/ingest.mjs                 # 重新写入 28 个切片（幂等）
node src/search.mjs "倒排索引 词项"   # 走 seekdb 的 MATCH ... AGAINST
node src/search.mjs --export        # 重新导出 web/data/index.json
```

没装依赖时 `node src/search.mjs "倒排索引"` 会自动降级为读导出索引用同一套 BM25 复算，
不报错，便于对照「seekdb 结果」与「离线复算」是否一致。
