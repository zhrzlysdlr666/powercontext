# 端侧迷你知识库 · 浏览器向量化 + seekdb 混合检索

OceanBase 2026 数据库大赛 · 阶跃星辰赛题（questionId 600073）提交物。

文档在浏览器里完成向量化（Transformers.js + ONNX Runtime Web，INT8 量化的 bge-small-zh-v1.5），
向量与原文写入**进程内嵌的 seekdb**，检索时由 seekdb 用**一条 SQL** 同时计算向量距离与全文 BM25 分并加权排序。
服务端只做存储与检索，不做任何推理；全流程不访问云端推理 API。

```
浏览器                              本地 Node 进程（127.0.0.1）
┌──────────────────────────┐        ┌──────────────────────────────┐
│ 语料切块                  │        │                              │
│   ↓                      │        │  seekdb（嵌入式，MySQL 协议） │
│ bge-small-zh-v1.5 (INT8) │        │   kb_docs                    │
│   WebGPU / WASM          │        │    ├─ embedding VECTOR(512)   │
│   ↓ 向量                  │──POST──▶    ├─ FULLTEXT (IK 分词)      │
│ 查询向量化（同一模型）     │        │    └─ kb / title / body       │
│   ↓                      │◀─JSON──│  ↑ 单条 SQL：MATCH + L2_DISTANCE│
└──────────────────────────┘        └──────────────────────────────┘
```

## 运行

```bash
cd stepfun
npm install            # @oceanbase/seekdb-node / mysql2 / @huggingface/transformers
npm run model          # 下载 bge-small-zh-v1.5（fp32 + 分词文件，走 hf-mirror 镜像）
npm run quantize       # 用 onnxruntime 动态量化为 INT8，写入 public/models/
npm start              # http://127.0.0.1:5173
```

- 浏览器：Chrome / Edge 最新版。首次启动会自动把 `node_modules` 里的 Transformers.js 运行时
  复制到 `public/vendor/transformers/`（无需手工准备）。
- Node ≥ 20。seekdb 以嵌入式方式随 Node 进程启动，随机端口，数据目录默认 `./data`
  （可用 `KB_DATA_DIR` 指定）。
- 没有 Python 量化环境时，可跳过 `npm run quantize`，改用
  `node scripts/fetch-model.mjs --with-official-int8` 直接取官方 INT8 权重
  （与本地量化同为 `quantize_dynamic(per-channel)` 产物，体积 24.01 MB）。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 5173 | 本地服务端口 |
| `KB_DATA_DIR` | `./data` | seekdb 数据目录（切换即为另一套知识库） |
| `KB_DIM` | 512 | 向量维度，需与模型一致 |
| `KB_VEC_WEIGHT` / `KB_FT_WEIGHT` | 0.6 / 0.4 | 融合权重 |
| `KB_FT_C` | 4 | 全文分饱和常数（`ft/(ft+C)`） |
| `KB_MAX_L2` | 1.2 | 语义召回的距离上限 |
| `KB_MEMORY` | 2G | seekdb 内存预算 |

### 后端切换与验收

| 地址 | 行为 |
| --- | --- |
| `/` | 默认策略：先初始化 WebGPU，不可用自动降级 WASM；若 WebGPU 实测比 WASM 慢 3 倍以上（软件光栅化/无 GPU），按实测降级并在界面写明原因 |
| `/?backend=webgpu` | 强制 WebGPU（失败直接报错，用于验证 GPU 路径） |
| `/?backend=wasm` | 强制 WASM（用于验证降级路径与 CPU 基准） |

界面右上角徽标始终显示当前后端、q8 精度、WASM 线程数；下方一行给出选择原因与两端探测延迟。

## 目录

```
server.mjs                 本地服务：内嵌 seekdb + 建表建索引 + 混合检索 SQL + 静态文件
public/index.html|app.js|style.css   前端：切块、向量化、导入、检索、计时、批大小扫描
public/models/             浏览器加载的模型（INT8，npm run model+quantize 生成）
public/vendor/transformers Transformers.js 运行时（启动时自动从 node_modules 复制）
samples/corpus.txt         25 段中文语料（财务/向量检索/端侧推理等主题），复现用
scripts/fetch-model.mjs    模型下载
scripts/quantize.py        INT8 动态量化
bench/quality.mjs          fp32 vs INT8 的检索质量与体积对比
bench/refresh_test.mjs     增量写入 / 索引刷新 / 集合隔离 的功能验证
bench/split_vs_fused.mjs   单条 SQL 融合 vs 两条 SQL 客户端合并的对照实验
bench/raw/*.json           实测原始数据（三种后端各一组）
```

## 复现实测

```bash
npm start                                  # 另开一个终端
node bench/refresh_test.mjs                # 功能：9/9 通过
node bench/quality.mjs                     # 质量：fp32 vs INT8
node bench/split_vs_fused.mjs              # 融合 vs 分离
```

浏览器侧计时（模型加载 / 文档向量化 / 写入 / 查询向量化 / seekdb 检索 / 端到端）在页面「3. 计时」区，
点击「跑 10 次基准」会追加 10 次重复的中位数，以及 batch=1/2/4/8/16/32 的批大小扫描。

## 关键结论

完整实测见 [TECHNICAL.md](TECHNICAL.md)。三条要点：

1. **INT8 量化**：94.85 MB → 24.02 MB（3.95×），逐块向量余弦 0.9948，Top1 一致率 100%、
   Recall@5 不变（100%），单条向量化 4.56 → 2.79 ms。
2. **后端选择**：不能只按「有没有 WebGPU」决策。本机（无独立 GPU，headless Edge）WebGPU
   走软件光栅化，单次推理 73 ms，比 4 线程 WASM 慢 14 倍；因此应用先探测再决策，并把原因写在界面上。
3. **批处理是最大杠杆**：WASM 侧 batch 1→4 吞吐 +26%（67.2→84.9 块/s），
   WebGPU 侧 batch 1→16 吞吐 +252%（11.5→40.5 块/s），GPU 后端必须配大批次才有优势。
