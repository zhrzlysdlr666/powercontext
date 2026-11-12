# 端侧知识库：浏览器本地向量化 + seekdb 库内混合检索

一个迷你知识库：导入文本 → 在**用户浏览器里**切块并生成向量 → 向量与原文写入 **seekdb** → 提问时同样在浏览器里生成查询向量，交给 seekdb 做**向量 + 全文的混合检索**（RRF 融合由数据库完成），返回排序结果与原文。

对应赛题：**seekdb × 阶跃星辰 —— 端侧 AI 推理性能优化与 seekdb 混合检索**（`stepfun` 目录）。

---

## 1. 运行

```bash
npm install                # 依赖：seekdb（含原生服务端） / @huggingface/transformers / esbuild
npm run setup              # 下载模型权重 + 打包浏览器运行时到 web/vendor
npm start                  # http://localhost:5173
```

`npm run setup` 做三件事，都会落到本地磁盘，**之后断网也能跑**：

| 产物 | 用途 | 体积 |
|---|---|---|
| `web/models/bge-small-zh-v1.5/onnx/model_quantized.onnx` | CPU 路径用的 INT8 权重 | 22.9 MiB |
| `web/models/bge-small-zh-v1.5/onnx/model_fp16.onnx` | WebGPU 路径用的 FP16 权重 | 45.3 MiB |
| `web/vendor/transformers.bundle.js` + `ort-wasm-simd-threaded.jsep.wasm` | 打成一个自包含 ES module 的推理运行时 | 0.83 + 20.6 MiB |

打开页面后点「载入示例语料」，再在右侧提问即可。

## 2. 架构

```
┌──────────────────────── 浏览器（唯一做推理的地方） ────────────────────────┐
│  Transformers.js + ONNX Runtime Web                                       │
│    WebGPU（FP16）── 失败/不可用 ──▶ WASM（INT8），界面显示当前后端          │
│    切块 → 批量 embedding → 查询 embedding                                  │
└───────────────┬───────────────────────────────────────────┬───────────────┘
                │ POST /api/import  {文本, 向量}              │ POST /api/search {查询, 查询向量}
┌───────────────▼───────────────────────────────────────────▼───────────────┐
│  Node 服务（server/index.mjs，只做存取，不加载任何模型）                     │
│    seekdb 本地 server 实例（@oceanbase/seekdb-node 拉起）                   │
│    seekdb-js（server 模式）→ collection：HNSW(512, cosine) + 全文(ik)       │
│    混合检索 → DBMS_HYBRID_SEARCH.GET_SQL(...) → 排序在库内完成（RRF）        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 为什么推理必须在这里分界

服务端创建 collection 时显式传 `embeddingFunction: null`，并且没有任何 embedding 依赖被安装——服务端在结构上就不可能替用户算向量。浏览器侧 `env.allowRemoteModels = false`，模型只从 `/models/` 读本地文件，代码里不存在任何指向推理 API 的请求。

### 混合检索为什么不是「客户端拼两路」

`collection.hybridSearch()` 在 seekdb-js 里会展开成 `SELECT DBMS_HYBRID_SEARCH.GET_SQL(table, @search_parm)`，两路召回与 RRF 融合都在数据库内执行，客户端只收到一份已排好序的结果。可以用一条 SQL 复核：

```sql
SELECT DBMS_HYBRID_SEARCH.GET_SQL('kb_chunks', @search_parm);
```

## 3. 实现要点

**① 后端与精度必须配对（实测踩坑，重要）**
ONNX Runtime 的 WebGPU 执行后端没有整数算子。把 INT8 权重丢给 WebGPU，session 不会报错，但**算出来的向量是错的**：同一段文本，WebGPU+INT8 与 CPU 结果的余弦只有 **0.29**，检索排序因此整体失真。所以本项目按后端选精度：

| 后端 | 权重 | 与 FP32 基准的余弦 |
|---|---|---|
| WebGPU | FP16 | **1.0000** |
| WASM | INT8 | 0.9901（INT8 与 FP32 的正常差距） |
| WebGPU | INT8（禁用） | 0.2866 ← 错误 |

界面右上角的 `后端 / 精度` 徽章实时显示当前组合，下拉框可以强制 `WebGPU（FP16）` 或 `WASM（INT8）`；强制失败会自动降级并在徽章上标注「已降级」及原因。

**② 量化**
默认 INT8，WebGPU 场景用 FP16，两者都对比 FP32 基准；体积、速度、质量的实测见第 4 节。切换后端会清空并重建集合——不同精度的向量不在同一空间，混用会让排序失效，这个约束在界面上有明确提示。

**③ 切块与上下文**
按段落聚合到约 340 字、相邻块留 60 字重叠；超长段落按中文句末标点切。**写入向量时把文档标题拼在正文前**（`标题\n正文`），只用于 embedding，展示与全文索引仍用原文——单独一段话常常看不出属于哪个主题，加上标题能明显减少「来自无关文档的邻居排到第一」。

**④ 增量写入、刷新与集合状态**
每篇文档一次 `upsert`（同 id 幂等，重复导入不会产生重复块），写完立即 `refresh_index()`；界面上的「写入后刷新索引」可以关掉，用来看刷新前后「新导入内容检索不到」的差别。集合可切换/重建，当前集合记在 `localStorage` 并同步到服务端，切换后检索结果只来自当前集合。

## 4. 实测数据

环境：Windows 11 / Edge（Chromium 142）/ i7 + 集显，语料 10 篇 10 块，标注查询 22 条（14 条贴近原文措辞 + 8 条改写问法）。

**检索质量（端到端，走真实 UI 与 API）**

| 检索方式 | Recall@1 | Recall@5 | MRR@10 |
|---|---|---|---|
| 混合（库内 RRF） | **95.5%** | **100%** | **0.966** |
| 纯向量 | 86.4% | 100% | 0.920 |
| 纯全文 | 77.3% | 100% | 0.873 |

混合检索把两路的互补性吃满：纯全文怕改写问法（"断网之后这个应用还能用吗" 命中不到"持久化"），纯向量怕专有名词和数字，融合后只剩 1 条 miss。

**量化对比（离线，Node + 同一套切块与库，`npm run eval`）**

| 变体 | 体积 | 模式 | Recall@1 | Recall@5 | MRR@10 | 文档向量化 | 查询向量化 |
|---|---|---:|---:|---:|---:|---:|---:|
| INT8 | 22.9 MiB | 混合 | 95.5% | 100% | 0.966 | 100.2 块/秒 | 4.7 ms |
| INT8 | | 纯向量 | 81.8% | 100% | 0.890 | | |
| INT8 | | 纯全文 | 77.3% | 100% | 0.873 | | |
| FP32 | 90.5 MiB | 混合 | 95.5% | 100% | 0.966 | 39.6 块/秒 | 7.8 ms |
| FP32 | | 纯向量 | 86.4% | 100% | 0.920 | | |
| FP32 | | 纯全文 | 77.3% | 100% | 0.873 | | |

结论：INT8 把体积压到 **1/3.95**、文档向量化快 **2.5 倍**、查询快 **1.7 倍**；混合检索的 top-1 在 22 条查询上与 FP32 **完全一致（0/22 差异）**。纯向量下 INT8 掉 1 条（86.4%→81.8%），被第二路全文召回补了回来——量化损失可以用混合检索兜住。

另外做过一次 RRF 参数扫描（`rank_constant` 1/5/10/30/60 × `rank_window_size` 20/50，`npm run tune`）：在本语料上 10 组配置的 top-1 完全相同，说明瓶颈不在融合权重，因此保持 seekdb 默认值，不做无依据的调参。

**性能**

批大小（Node 侧同一套切块与库，`npm run bench`，10 块）：

| batch | 吞吐（块/秒） | 每块耗时 |
|---:|---:|---:|
| 1 | 77.8 | 12.8 ms |
| 4 | 61.4 | 16.3 ms |
| 8 | 94.5 | 10.6 ms |
| 16 | **103.2** | 9.7 ms |

写入与检索（10 块）：

| 环节 | 耗时 |
|---|---|
| upsert 10 块 | 192 ms |
| `refresh_index()` | 4233 ms |
| 检索：纯向量 | 3.37 ms |
| 检索：纯全文 | 3.26 ms |
| 检索：混合（库内 RRF） | 13.32 ms |

浏览器端到端（Edge / WebGPU+FP16，点「载入示例语料」到可检索）：

| 环节 | 耗时 |
|---|---|
| 文档向量化（10 块，首批含 shader 编译） | 678 ms（14.7 块/秒） |
| 索引刷新（整批写完只刷一次） | 640 ms |
| 导入总计 | **1327 ms** |
| 查询向量化 | 12.4 ms |
| seekdb 检索 | 3.1 ms |

索引刷新是导入链路上最贵的一步（4.2 s/次），所以导入改成「整批 upsert 后只刷一次」，
并保留 `POST /api/refresh` 供手动触发；优化后导入总耗时从 ~5.3 s 降到 **1.5 s**。

## 5. 对应验收项

| 要求 | 实现位置 |
|---|---|
| 导入 → 向量化 → 写库 → 检索展示 | `web/app.js` 导入与检索流程，`server/index.mjs` `/api/import`、`/api/search` |
| 文档与查询都在浏览器嵌入 | `web/app.js` 的 `embed()`；服务端 `embeddingFunction: null` |
| INT8/FP16 + 体积与质量对比 | 第 3 节 ②、第 4 节；`tools/eval-quality.mjs` 可复跑 |
| WebGPU 优先、自动降级、界面提示 | `loadModel()` 的 `plan`；`.badge` 与 `#backend` |
| 向量/全文存 seekdb，混合检索在库内 | `collection.hybridSearch()` → `DBMS_HYBRID_SEARCH` |
| 增量导入、刷新后可见、集合与会话状态 | `upsert` + `refresh_index()`；`/api/reset`、`/api/collection` |
| 可复现 | `npm install && npm run setup && npm start` |

## 6. 目录

```
server/index.mjs         HTTP 服务 + seekdb 生命周期 + 存取接口
web/index.html          界面
web/app.js              端侧推理、切块、导入、检索、后端降级
web/style.css
web/corpus/seed.json    示例语料（也是评测语料）
tools/setup.mjs         下载权重 + 打包运行时
tools/bundle-runtime.mjs 把 transformers 打成自包含 ESM
tools/eval-quality.mjs  INT8 / FP32 质量与速度对比
tools/bench.mjs         批大小、写入、刷新的基准
tools/tune-rrf.mjs      RRF 参数扫描
tools/lib/              与应用一致的切块器、评测查询集
docs/eval.json          评测原始结果
docs/bench.json         基准原始结果
```

## 7. 已知限制

- 语料规模按「个人知识库」设计（10–10^3 块）；更大规模需要调 `memory_budget` 与 HNSW 参数。
- 图片、PDF 未解析，只接受纯文本与 Markdown。
- 首次推理有一次性 shader / 图优化开销（约 7–8 秒），界面进度条期间的等待主要来自这里；批量导入按 8 条一批，稳态吞吐见第 4 节。
