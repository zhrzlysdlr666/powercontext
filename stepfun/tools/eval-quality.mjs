// Measure what INT8 quantisation costs: retrieval quality, embedding latency and
// model size, all on the same corpus, the same chunker and the same database.
//
//   node tools/eval-quality.mjs
//
// Quality is judged by whether the chunk of the expected document shows up in
// the top 5, plus MRR@10. The FP32 variant is only downloaded here (and cached
// under .cache/) — the app itself ships INT8.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@huggingface/transformers";
import { seekdb } from "@oceanbase/seekdb-node";
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";
import { chunkText } from "./lib/chunk.mjs";
import { QUERIES } from "./lib/queries.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORPUS = path.join(ROOT, "web", "corpus", "seed.json");
const LOCAL_MODELS = path.join(ROOT, "web", "models");
const CACHE_MODELS = path.join(ROOT, ".cache", "models");
const DIMENSION = 512;
const TOP_K = 10;
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"];

async function ensureFp32() {
  const dir = path.join(CACHE_MODELS, "bge-small-zh-v1.5", "onnx");
  const file = path.join(dir, "model.onnx");
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model.onnx`, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log(`downloaded fp32 (${(fs.statSync(file).size / 1048576).toFixed(1)} MiB) from ${base}`);
      return file;
    } catch (error) {
      console.warn(`  ${base}: ${error.message}`);
    }
  }
  throw new Error("cannot fetch fp32 model");
}

async function copySidecars() {
  const src = path.join(LOCAL_MODELS, "bge-small-zh-v1.5");
  const dst = path.join(CACHE_MODELS, "bge-small-zh-v1.5");
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}

async function embedAll(extractor, texts, kind) {
  const started = process.hrtime.bigint();
  const inputs = texts.map((t) => (kind === "query" ? QUERY_PREFIX + t : t));
  const output = await extractor(inputs, { pooling: "cls", normalize: true });
  const list = output.tolist();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { vectors: Array.isArray(list[0]) ? list : [list], ms };
}

// One seekdb instance for the whole run: two instances in one process can pick
// the same port and then fight over connections.
async function openRuntime(databaseDir) {
  const runtime = await seekdb.open(databaseDir, {
    parameters: { memory_budget: "1G", mysql_port_mode: "random" },
  });
  const endpoint = runtime.connectionOptions();
  const client = new SeekdbClient({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: "",
    database: "test",
  });
  const schema = new Schema({
    fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
    vectorIndex: new VectorIndexConfig({
      hnsw: { dimension: DIMENSION, distance: "cosine" },
      embeddingFunction: null,
    }),
  });
  return { runtime, client, schema };
}

function flattenRows(value) {
  if (!Array.isArray(value)) return [];
  return Array.isArray(value[0]) ? value[0] : value;
}

async function evaluate(label, extractor, corpus, client, schema) {
  const collection = await client.getOrCreateCollection({ name: `eval_${label}`, schema });

  const rows = [];
  for (const doc of corpus) {
    const chunks = chunkText(doc.text);
    chunks.forEach((text, index) => rows.push({ id: `${doc.id}#${index}`, docId: doc.id, title: doc.title, index, text }));
  }
  // The app embeds each chunk together with its document title.
  const { vectors, ms: docMs } = await embedAll(extractor, rows.map((r) => `${r.title}\n${r.text}`), "document");
  await collection.upsert({
    ids: rows.map((r) => r.id),
    documents: rows.map((r) => r.text),
    metadatas: rows.map((r) => ({ docId: r.docId, title: r.title, chunkIndex: r.index })),
    embeddings: vectors,
  });
  await collection.refresh_index();

  const metrics = { vector: { hit1: 0, hit5: 0, mrr: 0 }, keyword: { hit1: 0, hit5: 0, mrr: 0 }, hybrid: { hit1: 0, hit5: 0, mrr: 0 } };
  const tops = [];
  let queryMs = 0;

  for (const item of QUERIES) {
    const { vectors: qv, ms } = await embedAll(extractor, [item.q], "query");
    queryMs += ms;
    const embedding = qv[0];

    const runs = {
      vector: await collection.query({
        queryEmbeddings: [embedding],
        nResults: TOP_K,
        include: ["metadatas"],
      }),
      keyword: await collection.get({ whereDocument: { $contains: item.q }, limit: TOP_K, include: ["metadatas"] }),
      hybrid: await collection.hybridSearch({
        query: { whereDocument: { $contains: item.q } },
        knn: { queryEmbeddings: [embedding] },
        nResults: TOP_K,
        include: ["metadatas"],
      }),
    };

    for (const [mode, result] of Object.entries(runs)) {
      const metas = flattenRows(result.metadatas);
      const rank = metas.findIndex((m) => m?.docId === item.doc);
      if (rank === 0) metrics[mode].hit1 += 1;
      if (rank >= 0 && rank < 5) metrics[mode].hit5 += 1;
      if (rank >= 0) metrics[mode].mrr += 1 / (rank + 1);
    }
    const topMeta = flattenRows(runs.hybrid.metadatas)[0];
    tops.push({ q: item.q, expected: item.doc, hybridTop: topMeta?.docId || null, ok: topMeta?.docId === item.doc });
  }

  const n = QUERIES.length;
  const summary = {};
  for (const [mode, m] of Object.entries(metrics)) {
    summary[mode] = { "Recall@1": m.hit1 / n, "Recall@5": m.hit5 / n, "MRR@10": m.mrr / n };
  }

  return {
    label,
    chunks: rows.length,
    docs: corpus.length,
    docEmbedMs: Number(docMs.toFixed(0)),
    docPerSecond: Number((rows.length / (docMs / 1000)).toFixed(1)),
    queryMs: Number((queryMs / n).toFixed(1)),
    ...summary,
    tops,
  };
}

// ---------------------------------------------------------------------- main

const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
await ensureFp32();
await copySidecars();

const stamp = Date.now();
const runtime = `./.eval-db-${stamp}`;

env.allowLocalModels = true;
env.allowRemoteModels = false;

env.localModelPath = LOCAL_MODELS + path.sep;
const q8 = await pipeline("feature-extraction", "bge-small-zh-v1.5", { dtype: "q8" });
env.localModelPath = CACHE_MODELS + path.sep;
const fp32 = await pipeline("feature-extraction", "bge-small-zh-v1.5", { dtype: "fp32" });

const q8Size = fs.statSync(path.join(LOCAL_MODELS, "bge-small-zh-v1.5", "onnx", "model_quantized.onnx")).size;
const fp32Size = fs.statSync(path.join(CACHE_MODELS, "bge-small-zh-v1.5", "onnx", "model.onnx")).size;

const { runtime: dbRuntime, client, schema } = await openRuntime(runtime);
const results = [await evaluate("int8", q8, corpus, client, schema), await evaluate("fp32", fp32, corpus, client, schema)];

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { documents: corpus.length, chunks: results[0].chunks },
  queries: QUERIES.length,
  model: { id: "Xenova/bge-small-zh-v1.5", dimension: DIMENSION, pooling: "cls", normalized: true },
  size: { int8Bytes: q8Size, fp32Bytes: fp32Size, ratio: Number((fp32Size / q8Size).toFixed(2)) },
  results,
};

fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "eval.json"), JSON.stringify(report, null, 2));

const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(`\nmodel  INT8 ${(q8Size / 1048576).toFixed(1)} MiB  |  FP32 ${(fp32Size / 1048576).toFixed(1)} MiB  |  ratio ${report.size.ratio}x`);
console.log(`corpus ${corpus.length} docs / ${report.corpus.chunks} chunks, ${QUERIES.length} labelled queries, top-${TOP_K}\n`);
console.log("variant  mode     Recall@1  Recall@5  MRR@10   doc-embed      query-embed");
for (const r of results) {
  for (const mode of ["vector", "keyword", "hybrid"]) {
    console.log(
      `${r.label.padEnd(8)} ${mode.padEnd(8)} ${pct(r[mode]["Recall@1"]).padEnd(9)} ${pct(r[mode]["Recall@5"]).padEnd(
        9,
      )} ${r[mode]["MRR@10"].toFixed(3).padEnd(8)} ${String(r.docPerSecond).padStart(6)} chunk/s   ${r.queryMs} ms`,
    );
  }
}
const changed = results[0].tops.filter((t, i) => t.hybridTop !== results[1].tops[i].hybridTop);
console.log(`\ntop-1 differs between INT8 and FP32 on ${changed.length}/${QUERIES.length} queries`);
for (const c of changed) console.log(`  ${c.q} -> int8:${c.hybridTop} fp32:${results[1].tops.find((t) => t.q === c.q).hybridTop}`);
console.log("\nwrote docs/eval.json");

await client.close();
dbRuntime.close();
