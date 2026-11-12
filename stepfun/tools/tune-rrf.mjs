// RRF knobs: with a 16-chunk corpus the default rank constant flattens the
// fused scores, so sweep it and keep the setting that ranks the labelled answer
// first most often.
//
//   node tools/tune-rrf.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, env } from "@huggingface/transformers";
import { seekdb } from "@oceanbase/seekdb-node";
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";
import { chunkText } from "./lib/chunk.mjs";
import { QUERIES } from "./lib/queries.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "corpus", "seed.json"), "utf8"));
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = path.join(ROOT, "web", "models") + path.sep;
const extractor = await pipeline("feature-extraction", "bge-small-zh-v1.5", { dtype: "q8" });

async function embed(texts) {
  const out = await extractor(texts, { pooling: "cls", normalize: true });
  const list = out.tolist();
  return Array.isArray(list[0]) ? list : [list];
}

const rows = corpus.flatMap((doc) => chunkText(doc.text).map((text, index) => ({ id: `${doc.id}#${index}`, docId: doc.id, text })));
const vectors = await embed(rows.map((r) => r.text));

const runtime = await seekdb.open(`./.tune-db-${Date.now()}`, {
  parameters: { memory_budget: "1G", mysql_port_mode: "random" },
});
const ep = runtime.connectionOptions();
const client = new SeekdbClient({ host: ep.host, port: ep.port, user: ep.user, password: "", database: "test" });
const schema = new Schema({
  fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
  vectorIndex: new VectorIndexConfig({ hnsw: { dimension: 512, distance: "cosine" }, embeddingFunction: null }),
});
const collection = await client.getOrCreateCollection({ name: "tune", schema });
await collection.upsert({
  ids: rows.map((r) => r.id),
  documents: rows.map((r) => r.text),
  metadatas: rows.map((r) => ({ docId: r.docId })),
  embeddings: vectors,
});
await collection.refresh_index();

const queryVectors = await embed(QUERIES.map((item) => QUERY_PREFIX + item.q));

const variants = [];
for (const k of [1, 5, 10, 30, 60]) {
  for (const window of [20, 50]) {
    let hit1 = 0;
    let mrr = 0;
    for (let i = 0; i < QUERIES.length; i += 1) {
      const result = await collection.hybridSearch({
        query: { whereDocument: { $contains: QUERIES[i].q } },
        knn: { queryEmbeddings: [queryVectors[i]] },
        nResults: 10,
        rank: { rrf: { rankConstant: k, rankWindowSize: window } },
        include: ["metadatas"],
      });
      const metas = Array.isArray(result.metadatas[0]) ? result.metadatas[0] : result.metadatas;
      const rank = metas.findIndex((m) => m?.docId === QUERIES[i].doc);
      if (rank === 0) hit1 += 1;
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    variants.push({ rankConstant: k, rankWindowSize: window, recall1: hit1 / QUERIES.length, mrr: mrr / QUERIES.length });
    console.log(`k=${String(k).padStart(2)} window=${window}  top1 ${(hit1 / QUERIES.length * 100).toFixed(1)}%  mrr ${(mrr / QUERIES.length).toFixed(3)}`);
  }
}
const best = variants.sort((a, b) => b.recall1 - a.recall1 || b.mrr - a.mrr)[0];
console.log(`\nbest: rankConstant=${best.rankConstant} rankWindowSize=${best.rankWindowSize} top1=${(best.recall1 * 100).toFixed(1)}% mrr=${best.mrr.toFixed(3)}`);
await client.close();
runtime.close();
