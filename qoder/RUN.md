# 运行说明（RUN）

仓库根目录即入口，**零依赖**：不需要 `pip install`，也不需要 `npm install`。

## 1. 自检（推荐，约 1 秒）

```bash
python main.py        # 只依赖 Python 标准库
python3 main.py       # 环境里只有 python3 时
node main.mjs         # 环境里只有 node 时（>=18）
./run.sh              # 让脚本自动挑 python3 / python / node
```

预期：打印 `SELFCHECK PASS`，退出码 0。

## 2. 起服务

```bash
./run.sh --serve      # http://127.0.0.1:8899/
python main.py --serve
node main.mjs --serve # 或 cd qoder && npm start，默认 3000 端口
```

接口：

- `GET /api/health` → `{"ok":true,"engine":"seekdb ...","chunks":28,"docs":5,"presets":12}`
- `GET /api/search?q=倒排索引` → `{"q":"倒排索引","engine":"bm25","total":8,"hits":[...]}`
- 别名：`/health`、`/search`

## 3. 看页面

浏览器打开 `http://127.0.0.1:8899/`，或直接双击 `qoder/web/index.html`（索引已内联，`file://` 可用）。

线上作品页：https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录；支持 `?q=关键词` 深链）

## 4. 容器（可选）

```bash
docker build -t studylens . && docker run --rm -p 3000:3000 studylens
cd qoder && docker compose up --build     # 等价
```

## 5. 可选：重建索引（需要 seekdb）

```bash
cd qoder
npm install @oceanbase/seekdb-node mysql2   # 只有这一步联网
node src/ingest.mjs
node src/search.mjs "倒排索引 词项"
node src/search.mjs --export
```

## 运行环境

- Python 3.8+（纯标准库）或 Node.js 18+
- 操作系统：Windows / Linux / macOS 均可
- 无网络要求（索引与页面数据已随仓库提供）
