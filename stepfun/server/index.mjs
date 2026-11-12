// Local server for the on-device knowledge base.
//
// Responsibilities split:
//   * the browser owns the model — every document and query vector is produced
//     on the user's device by Transformers.js (WebGPU, or WASM when the browser
//     has no WebGPU). This process never calls a cloud inference API.
//   * this process owns the database — seekdb is started in local server mode
//     through the Node bindings, and seekdb-js talks to it.
//
// Hybrid retrieval is executed by the database itself: seekdb-js expands the
// call into DBMS_HYBRID_SEARCH.GET_SQL and the ranking happens inside seekdb.
// The client never receives two result lists to merge on its own.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seekdb } from "@oceanbase/seekdb-node";
import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIR = path.join(ROOT, "web");
const DATA_DIR = process.env.SEEPDB_DIR || path.join(ROOT, "data", "seekdb");
const PORT = Number(process.env.PORT || 5173);
const DIMENSION = Number(process.env.EMBEDDING_DIM || 512);
const DEFAULT_COLLECTION = process.env.COLLECTION || "kb_chunks";
const MAX_BODY = 128 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const state = {
  runtime: null,
  client: null,
  collections: new Map(),
  active: DEFAULT_COLLECTION,
  startedAt: Date.now(),
};

function buildSchema() {
  return new Schema({
    // Chinese full-text needs a real tokenizer; the default one answers nothing.
    fulltextIndex: new FulltextIndexConfig("ik", { ik_mode: "smart" }),
    // embeddingFunction: null — vectors always arrive from the browser, so no
    // embedding is computed on this side.
    vectorIndex: new VectorIndexConfig({
      hnsw: { dimension: DIMENSION, distance: "cosine" },
      embeddingFunction: null,
    }),
  });
}

async function boot() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  state.runtime = await seekdb.open(DATA_DIR, {
    parameters: {
      memory_budget: process.env.SEEPDB_MEMORY || "1G",
      mysql_port_mode: "random",
    },
  });
  const endpoint = state.runtime.connectionOptions();
  state.client = new SeekdbClient({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: "",
    database: "test",
  });
  await useCollection(DEFAULT_COLLECTION);
}

async function useCollection(name) {
  let collection = state.collections.get(name);
  if (!collection) {
    // embeddingFunction: null on both create and open — no embedding is ever
    // computed here, and reopening a collection must not ask for a default one.
    collection = await state.client.getOrCreateCollection({ name, schema: buildSchema(), embeddingFunction: null });
    state.collections.set(name, collection);
  }
  state.active = name;
  return collection;
}

function active() {
  const collection = state.collections.get(state.active);
  if (!collection) throw new Error(`collection ${state.active} is not open`);
  return collection;
}

// ---------------------------------------------------------------- handlers

async function apiState() {
  const collection = active();
  const count = await collection.count();
  return {
    ok: true,
    engine: "seekdb (local server mode)",
    version: state.runtime?.version?.() || null,
    collection: state.active,
    collections: [...state.collections.keys()],
    dimension: DIMENSION,
    chunks: count,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    embedding: "in-browser (Transformers.js)",
  };
}

async function apiImport(body) {
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  if (!chunks.length) throw new Error("no chunks to write");
  const collection = active();
  await collection.upsert({
    ids: chunks.map((c) => c.id),
    documents: chunks.map((c) => c.text),
    metadatas: chunks.map((c) => ({
      docId: c.docId,
      title: c.title || c.docId,
      chunkIndex: c.index ?? 0,
      chars: c.text.length,
    })),
    embeddings: chunks.map((c) => c.embedding),
  });
  // New rows are not guaranteed to be visible to the ANN index until it is
  // refreshed; the UI can switch this off on purpose to show the difference.
  if (body.refresh !== false) await collection.refresh_index();
  return { ok: true, written: chunks.length, chunks: await collection.count() };
}

async function apiRefresh() {
  const collection = active();
  const started = process.hrtime.bigint();
  await collection.refresh_index();
  return { ok: true, ms: Number(Number(process.hrtime.bigint() - started) / 1e6).toFixed(0), chunks: await collection.count() };
}

async function apiSearch(body) {
  const query = String(body.query || "").trim();
  const embedding = body.embedding;
  const topK = Math.min(Math.max(Number(body.topK) || 8, 1), 50);
  const mode = body.mode || "hybrid";
  if (!query) throw new Error("empty query");
  if (!Array.isArray(embedding)) throw new Error("missing query embedding (embedding must happen in the browser)");
  const collection = active();

  const started = process.hrtime.bigint();
  let result;
  if (mode === "vector") {
    result = await collection.query({
      queryEmbeddings: [embedding],
      nResults: topK,
      include: ["documents", "metadatas", "distances"],
    });
  } else if (mode === "keyword") {
    // Full-text matching ranked by the database's own MATCH ... AGAINST.
    result = await collection.get({
      whereDocument: { $contains: query },
      limit: topK,
      include: ["documents", "metadatas"],
    });
  } else {
    result = await collection.hybridSearch({
      query: { whereDocument: { $contains: query } },
      knn: { queryEmbeddings: [embedding] },
      nResults: topK,
      include: ["documents", "metadatas", "distances"],
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const ids = flatten(result.ids);
  const texts = flatten(result.documents);
  const metadatas = flatten(result.metadatas);
  const scores = flatten(result.distances);

  const hits = ids.map((id, i) => ({
    id,
    text: texts[i] || "",
    docId: metadatas[i]?.docId || "",
    title: metadatas[i]?.title || metadatas[i]?.docId || "",
    chunkIndex: metadatas[i]?.chunkIndex ?? null,
    score: typeof scores[i] === "number" ? scores[i] : null,
  }));
  return {
    ok: true,
    mode,
    query,
    collection: state.active,
    dbMs: Number(elapsedMs.toFixed(2)),
    fusedBy: mode === "hybrid" ? "seekdb DBMS_HYBRID_SEARCH (RRF)" : mode,
    hits,
  };
}

async function apiDocs() {
  const collection = active();
  const page = await collection.get({ limit: 2000, include: ["metadatas"] });
  const metadatas = flatten(page.metadatas);
  const docs = new Map();
  for (const meta of metadatas) {
    if (!meta?.docId) continue;
    const entry = docs.get(meta.docId) || { docId: meta.docId, title: meta.title, chunks: 0, chars: 0 };
    entry.chunks += 1;
    entry.chars += Number(meta.chars) || 0;
    docs.set(meta.docId, entry);
  }
  return { ok: true, total: docs.size, docs: [...docs.values()].sort((a, b) => a.docId.localeCompare(b.docId)) };
}

async function apiCollection(body) {
  const name = String(body.name || "").trim();
  if (!/^[A-Za-z0-9_]{1,60}$/.test(name)) throw new Error("collection name must be letters, digits or _");
  if (body.action === "drop") {
    await state.client.deleteCollection(name);
    state.collections.delete(name);
    if (state.active === name) await useCollection(DEFAULT_COLLECTION);
    return apiState();
  }
  await useCollection(name);
  return apiState();
}

async function apiReset() {
  const name = state.active;
  await state.client.deleteCollection(name);
  state.collections.delete(name);
  await useCollection(name);
  return apiState();
}

function flatten(value) {
  if (!Array.isArray(value)) return [];
  // seekdb returns one array per query vector; we always send exactly one.
  if (Array.isArray(value[0])) return value[0];
  return value;
}

// ---------------------------------------------------------------- plumbing

function send(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on("end", () => {
      if (!parts.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith("models/") || rel.startsWith("vendor/");
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": immutable ? "public, max-age=604800" : "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}

const ROUTES = {
  "GET /api/state": apiState,
  "GET /api/docs": apiDocs,
  "POST /api/import": apiImport,
  "POST /api/refresh": apiRefresh,
  "POST /api/search": apiSearch,
  "POST /api/collection": apiCollection,
  "POST /api/reset": apiReset,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (key === "GET /api/health") return send(res, 200, { ok: true });
    const handler = ROUTES[key];
    if (handler) {
      const body = req.method === "POST" ? await readBody(req) : {};
      return send(res, 200, await handler(body));
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url.pathname);
    send(res, 404, { ok: false, error: "no such endpoint" });
  } catch (error) {
    console.error(`[api] ${key} ->`, error.message);
    send(res, 400, { ok: false, error: error.message });
  }
});

await boot();
server.listen(PORT, () => {
  console.log(`on-device knowledge base  ->  http://localhost:${PORT}`);
  console.log(`seekdb data directory     ->  ${DATA_DIR}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      state.runtime?.close?.();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
