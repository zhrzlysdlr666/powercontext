# 技术说明 · 端侧 AI 推理性能优化与 seekdb 混合检索

提交物：`stepfun/`（本目录）。应用可本地一键启动，浏览器内完成全部推理，seekdb 以嵌入式方式随进程启动。

---

## 1. 模型与量化

**模型来源**：`Xenova/bge-small-zh-v1.5`（BAAI bge-small-zh-v1.5 的 ONNX 导出，MIT/Apache-2.0 开源），
512 维、12 层、中文检索优化，适合端侧。运行时 `@huggingface/transformers` 3.7.6（Transformers.js），推理后端为它内置的 ONNX Runtime Web
（WebAssembly SIMD 多线程 / WebGPU 两套 EP）。
分词文件与 config 均随仓库提供（`npm run model` 从 hf-mirror 拉取）。

**量化方式**：ONNX Runtime `quantize_dynamic`

| 项 | 取值 |
| --- | --- |
| 权重 | INT8（QUInt8），**per-channel**（每行独立 scale） |
| 激活 | 运行时动态确定 scale（无需校准集） |
| 量化算子 | 仅 `MatMul` / `Gather`（Embedding）；LayerNorm、Softmax、GELU、残差保持 fp32 |
| 脚本 | `scripts/quantize.py`（`npm run quantize`），可完全复现 |

**体积与压缩比**（同一口径：实际 `.onnx` 文件字节数）

| 版本 | 体积 | 压缩比 |
| --- | --- | --- |
| fp32（`model.onnx`） | 94.85 MB | — |
| INT8 per-channel（`model_quantized.onnx`，提交版本） | 24.02 MB | **3.95×** |
| INT8 per-tensor（对照） | 23.92 MB | 3.97× |

**检索质量变化**（同一评测集：25 段语料 / 18 条标注查询，纯向量排序，`bench/quality.mjs`）

| 指标 | fp32 | INT8 (per-channel) | 变化 |
| --- | --- | --- | --- |
| 逐块向量余弦一致性 | — | mean 0.9948（min 0.9935 / max 0.9960） | — |
| Top-1 命中一致率 | — | 100% | 0 |
| Top-5 结果重合率 | — | 95.6% | −4.4 pt |
| Recall@5 | 100% | 100% | 0 |
| MRR | 0.9167 | 0.9167 | 0 |
| 单条向量化耗时（Node CPU，43 条均值） | 4.56 ms | 2.79 ms | **−39%** |

per-tensor 对照组：余弦 0.9739、Top-1 一致 94.4%、Top-5 重合 86.7%，故选择 per-channel（体积多 0.1 MB，换取明显更好的保真度）。

---

## 2. 端侧运行与后端选择

- **推理位置**：文档向量化与查询向量化都走页面内的同一个 pipeline 实例，服务端只接收向量与原文，**无任何推理 API**。
- **WebGPU 显式配置**：`pipeline(..., { device: 'webgpu', dtype: 'q8' })`。WebGPU 初始化失败时 try/catch 降级。
- **WASM 多线程**：服务端对所有响应加 `COOP: same-origin` + `COEP: require-corp`，页面获得
  `crossOriginIsolated`，`env.backends.onnx.wasm.numThreads = min(4, 核数−1)`，已实测生效。
- **选择策略（探针择优）**：`auto` 模式下先初始化 WebGPU 并探测 3 次单条推理，再探测 WASM；
  WebGPU 只要不慢于 WASM 的 3 倍就用 WebGPU（满足“优先 WebGPU”），否则按实测降级。
  决策与两端延迟都写在界面徽标下方，探测结果缓存 7 天（localStorage），二次访问跳过探测。
  `?backend=webgpu` / `?backend=wasm` 可强制，用于验证两条路径。

**实测（本机：Windows 11 / Edge headless / 8 逻辑核 / 无独立 GPU，WebGPU 由 SwiftShader 软件光栅化）**

| 阶段 | WASM 4 线程 | WebGPU（软光栅） |
| --- | --- | --- |
| 模型加载（强制单后端） | 709 ms | 1.36 s |
| 模型加载（auto，含双后端初始化+探测） | 1.53 s | — |
| 模型加载（二次访问，HTTP+探测缓存） | **189 ms** | — |
| 文档向量化 25 块（batch=8） | 397 ms（63.0 块/s） | 719 ms（34.7 块/s） |
| 查询向量化（中位数，10 次） | 3.7 ms | 73.1 ms |
| seekdb 混合检索（中位数） | 2.2 ms | 2.3 ms |
| 端到端（提交查询→结果可见） | **9.4 ms** | 78.7 ms |

`auto` 实测输出：`WebGPU 可用但实测 73.5 ms/次，比 WASM 慢 14.1 倍（疑似软件光栅化），按实测降级到 WASM` ——
在本机 WebGPU 反而更慢，说明“有 WebGPU 就用 WebGPU”不成立，必须按实测决策；真实 GPU 机器上探针会自动选回 WebGPU。

---

## 3. seekdb 使用

**接入方式**：`@oceanbase/seekdb-node` 1.4.0 进程内嵌入式启动（`seekdb.open(dataDir)`，随机端口），
上层用 `mysql2` 走 MySQL 协议，无外部依赖、无手工部署。

```sql
CREATE TABLE kb_docs (
  id VARCHAR(64) PRIMARY KEY,
  kb VARCHAR(64) NOT NULL DEFAULT 'default',   -- 知识库（集合）
  title VARCHAR(255), body MEDIUMTEXT, source VARCHAR(255),
  embedding VECTOR(512),
  FULLTEXT KEY ft_body (title, body) WITH PARSER IK,
  KEY idx_kb (kb)
);
CREATE VECTOR INDEX vidx_embedding ON kb_docs (embedding)
  WITH (distance=l2, type=hnsw, lib=vsag);
```

**混合检索在库内完成**（一条 SQL，两路打分 + 加权排序，客户端只渲染结果）：

```sql
SELECT id, kb, title, body, source,
       MATCH(title, body) AGAINST(:q IN NATURAL LANGUAGE MODE) AS ft_score,
       L2_DISTANCE(embedding, :v) AS l2,
       0.6 * (1.0 / (1.0 + L2_DISTANCE(embedding, :v)))
     + 0.4 * (MATCH(title, body) AGAINST(:q IN NATURAL LANGUAGE MODE)
              / (MATCH(title, body) AGAINST(:q IN NATURAL LANGUAGE MODE) + 4)) AS score
  FROM kb_docs
 WHERE kb = :kb
   AND (MATCH(title, body) AGAINST(:q IN NATURAL LANGUAGE MODE) > 0
        OR L2_DISTANCE(embedding, :v) <= 1.2)
 ORDER BY score DESC LIMIT :k;
```

- 全文分用 `ft/(ft+C)` 压到 [0,1) 而不是直接截断，避免 BM25 高分文档全部饱和成同一个分数。
- `MAX_L2` 门槛只让足够接近的向量进入候选集，防止向量项把无关文档拉进结果。
- **融合 vs 分离对照**（20 条查询，`bench/split_vs_fused.mjs`）：单条 SQL 2.63 ms，
  两条单路 SQL + 客户端合并 2.78 ms（1.05×）。本地内嵌库网络开销为零，延迟差不大；
  但分离式两路各截断 top-k，Top-5 结果平均只有 **3.55/5** 与融合结果重合（Top-1 仍 20/20 一致），
  即尾部排序会漂移 —— 这也是把融合放进库内的主要理由。

**增量写入与索引刷新**：单事务内多行 `INSERT ... ON DUPLICATE KEY UPDATE`（同 id 覆盖、不产生重复行）；
seekdb 的全文与向量索引随事务提交生效，**导入后立即可检索，无需重建索引或等待刷新**。
`bench/refresh_test.mjs` 逐项验证 9/9 通过：首次导入可检索、增量追加可检索、同 id 覆盖不重复、
A 库看不到 B 库、B 库只返回自己、集合列表正确、清空只影响当前库。

---

## 4. 状态与优化

**状态管理**：`kb` 列即集合，所有读写都带 `kb = ?` 过滤；前端用下拉框切换知识库并把当前库记在
localStorage，刷新页面后仍指向同一个集合；新建知识库即为空集合，互不影响。
同一文档 id 重复导入是覆盖而非追加，因此“连续导入同一份语料”不会让结果翻倍。

**优化项与前后对比**

| 优化 | 前 | 后 | 说明 |
| --- | --- | --- | --- |
| INT8 动态量化 | 94.85 MB / 4.56 ms | 24.02 MB / 2.79 ms | 体积 −74.7%，单条推理 −39%，Recall@5 不变 |
| embedding 批处理（WASM） | batch=1 67.2 块/s | batch=4 **84.9 块/s** | +26%；>16 因 padding 与内存峰值回落 |
| embedding 批处理（WebGPU） | batch=1 11.5 块/s | batch=16 **40.5 块/s** | +252%，GPU 必须大批次才能摊薄 dispatch 开销 |
| 后端探测缓存 | 每次访问 1.53 s | **189 ms** | 探测结果存 localStorage（7 天），二次访问跳过双后端初始化 |
| 模型文件缓存 | 冷启动重新下载 | `cache-control: max-age=86400` | 24 MB 模型二次访问走 HTTP 缓存 |
| 检索融合 | 两路 SQL + 客户端合并 | 单条 SQL 内融合 | 延迟持平（本地库），但排序一致、无分支截断 |
| 索引刷新 | 需重建/等待 | 提交即可见 | 端到端 0 等待；导入 25 块 397 ms，检索 2.2 ms |

**未做/边界**：本机无独立 GPU，WebGPU 只在软件光栅化下验证了功能与降级逻辑，
真实 GPU 的吞吐优势（预期 batch=16~32 时显著高于 CPU）需在有独立显卡的机器上复测；
语料规模为 25 块量级，HNSW 索引在大数据量下的召回/延迟曲线未展开。

---

## 5. 复现命令

```bash
cd stepfun && npm install && npm run model && npm run quantize && npm start
node bench/refresh_test.mjs      # 功能验证 9/9
node bench/quality.mjs           # fp32 vs INT8 质量/体积
node bench/split_vs_fused.mjs    # 融合 vs 分离
```

原始数据：`bench/raw/{r3_auto,r3_wasm,r3_webgpu,reload}.json`、`bench/quality.json`、
`bench/split_vs_fused.json`；页面「3. 计时」区的 10 次重复与批大小扫描为同一进程内实测。
