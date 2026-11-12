// Baseline measurements for the report: how much batching helps, what the index
// refresh costs, and how the two search paths compare in the database.
//
//   node tools/bench.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@huggingface/transformers";
import { seekdb } from "@oceanbase/seekdb-node";
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";
import { chunkText } from "./lib/chunk.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "corpus", "seed.json"), "utf8"));
const DIMENSION = 512;
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = path.join(ROOT, "web", "models") + path.sep;
const extractor = await pipeline("feature-extraction", "bge-small-zh-v1.5", { dtype: "q8" });

const chunks = corpus.flatMap((doc) =>
  chunkText(doc.text).map((text, index) => ({
    id: `${doc.id}#${index}`,
    docId: doc.id,
    title: doc.title,
    text,
    embedded: `${doc.title}\n${text}`,
  })),
);

async function embed(texts) {
  const started = process.hrtime.bigint();
  const out = await extractor(texts, { pooling: "cls", normalize: true });
  const list = out.tolist();
  return { vectors: Array.isArray(list[0]) ? list : [list], ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

const batching = [];
for (const size of [1, 4, 8, 16]) {
  // warm up so the first-call graph optimisation does not distort the sample
  await embed(chunks.slice(0, 2).map((c) => c.text));
  const { ms } = await embed(chunks.map((c) => c.text)).catch(() => ({ ms: 0 }));
  // emulate the batch size by timing per-batch calls
  const started = process.hrtime.bigint();
  let done = 0;
  for (let i = 0; i < chunks.length; i += size) {
    const batch = chunks.slice(i, i + size).map((c) => c.text);
    await embed(batch);
    done += batch.length;
  }
  const total = Number(process.hrtime.bigint() - started) / 1e6;
  batching.push({ batchSize: size, chunks: done, totalMs: Number(total.toFixed(0)), perChunkMs: Number((total / done).toFixed(1)), chunksPerSecond: Number((done / (total / 1000)).toFixed(1)) });
  console.log(`batch=${String(size).padStart(2)}  ${total.toFixed(0).padStart(5)} ms  ${(done / (total / 1000)).toFixed(1).padStart(6)} chunk/s`);
  void ms;
}

const runtime = await seekdb.open(`./.bench-db-${Date.now()}`, {
  parameters: { memory_budget: "1G", mysql_port_mode: "random" },
});
const endpoint = runtime.connectionOptions();
const client = new SeekdbClient({ host: endpoint.host, port: endpoint.port, user: endpoint.user, password: "", database: "test" });
const schema = new Schema({
  fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
  vectorIndex: new VectorIndexConfig({ hnsw: { dimension: DIMENSION, distance: "cosine" }, embeddingFunction: null }),
});
const collection = await client.getOrCreateCollection({ name: "bench", schema });

const { vectors } = await embed(chunks.map((c) => c.embedded));
const insertStart = process.hrtime.bigint();
await collection.upsert({
  ids: chunks.map((c) => c.id),
  documents: chunks.map((c) => c.text),
  metadatas: chunks.map((c) => ({ docId: c.docId })),
  embeddings: vectors,
});
const insertMs = Number(process.hrtime.bigint() - insertStart) / 1e6;
const refreshStart = process.hrtime.bigint();
await collection.refresh_index();
const refreshMs = Number(process.hrtime.bigint() - refreshStart) / 1e6;

const queries = ["INT8 量化会让模型变小多少", "导入后马上提问为什么查不到", "WebGPU 不可用时怎么办", "RDF 融合为什么看排名"];
const search = { vector: [], keyword: [], hybrid: [] };
for (const q of queries) {
  const { vectors: qv } = await embed([QUERY_PREFIX + q]);
  const embedding = qv[0];
  for (const mode of ["vector", "keyword", "hybrid"]) {
    const started = process.hrtime.bigint();
    if (mode === "vector") await collection.query({ queryEmbeddings: [embedding], nResults: 6, include: ["metadatas"] });
    else if (mode === "keyword") await collection.get({ whereDocument: { $contains: q }, limit: 6, include: ["metadatas"] });
    else
      await collection.hybridSearch({
        query: { whereDocument: { $contains: q } },
        knn: { queryEmbeddings: [embedding] },
        nResults: 6,
        include: ["metadatas"],
      });
    search[mode].push(Number(process.hrtime.bigint() - started) / 1e6);
  }
}
const avg = (arr) => Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { documents: corpus.length, chunks: chunks.length },
  runtime: { platform: process.platform, node: process.version, backend: "wasm (node)" },
  batching,
  write: { chunks: chunks.length, upsertMs: Number(insertMs.toFixed(0)), refreshIndexMs: Number(refreshMs.toFixed(0)) },
  searchMs: { vector: avg(search.vector), keyword: avg(search.keyword), hybrid: avg(search.hybrid) },
};

fs.writeFileSync(path.join(ROOT, "docs", "bench.json"), JSON.stringify(report, null, 2));
console.log(`\nupsert ${chunks.length} chunks: ${insertMs.toFixed(0)} ms, refresh_index ${refreshMs.toFixed(0)} ms`);
console.log(`search avg  vector ${report.searchMs.vector} ms | keyword ${report.searchMs.keyword} ms | hybrid ${report.searchMs.hybrid} ms`);
console.log("wrote docs/bench.json");
await client.close();
runtime.close();
