// Everything below the "model" heading runs on the user's device. The server
// only stores vectors and answers search requests, so no text ever leaves the
// machine for inference.
import { pipeline, env } from "./vendor/transformers.bundle.js";

const MODEL_ID = "bge-small-zh-v1.5";
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const BATCH_SIZE = 8;
const CHUNK_CHARS = 340;
const CHUNK_OVERLAP = 60;

env.allowLocalModels = true;
env.localModelPath = "/models/";
env.allowRemoteModels = false;
env.backends.onnx.wasm.wasmPaths = "/vendor/";
env.useBrowserCache = true;

const el = (id) => document.getElementById(id);
const ui = {
  badgeDevice: el("badgeDevice"),
  badgeDtype: el("badgeDtype"),
  badgeDb: el("badgeDb"),
  backend: el("backend"),
  drop: el("drop"),
  file: el("file"),
  paste: el("paste"),
  btnSample: el("btnSample"),
  btnImport: el("btnImport"),
  progress: el("progress"),
  barFill: el("barFill"),
  progressText: el("progressText"),
  collection: el("collection"),
  btnSwitch: el("btnSwitch"),
  btnReset: el("btnReset"),
  btnRefresh: el("btnRefresh"),
  refresh: el("refresh"),
  statDocs: el("statDocs"),
  statChunks: el("statChunks"),
  statDim: el("statDim"),
  docList: el("docList"),
  query: el("query"),
  btnSearch: el("btnSearch"),
  topK: el("topK"),
  timing: el("timing"),
  hits: el("hits"),
  log: el("log"),
};

const state = {
  extractor: null,
  device: "wasm",
  dtype: "q8",
  dim: 0,
  loading: null,
  ready: false,
};

function log(message) {
  ui.log.textContent = message;
}

function setProgress(current, total, label) {
  ui.progress.hidden = false;
  ui.barFill.style.width = `${total ? Math.round((current / total) * 100) : 0}%`;
  ui.progressText.textContent = label;
}

function hideProgress() {
  ui.progress.hidden = true;
  ui.barFill.style.width = "0";
}

// ------------------------------------------------------------------ model

async function detectDevice() {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? "webgpu" : null;
  } catch {
    return null;
  }
}

// Which weights run on which backend. The quantised graph cannot execute on the
// WebGPU execution provider — ONNX Runtime has no integer kernels there and the
// session silently returns a different vector (we measured cosine 0.29 against
// the CPU result), so WebGPU gets FP16 and the CPU path gets INT8.
const DTYPE_FOR = { webgpu: "fp16", wasm: "q8" };
const DTYPE_LABEL = { q8: "INT8", fp16: "FP16", fp32: "FP32" };

async function loadModel(force = "auto") {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    const gpu = await detectDevice();
    const plan = [];
    if (force === "wasm") plan.push("wasm");
    else if (force === "webgpu") plan.push("webgpu", "wasm");
    else {
      if (gpu) plan.push("webgpu");
      plan.push("wasm");
    }

    let fallbackReason = gpu ? "" : "当前浏览器未提供 WebGPU";
    for (const device of plan) {
      const dtype = DTYPE_FOR[device];
      try {
        ui.badgeDevice.textContent = `后端：加载 ${device.toUpperCase()} …`;
        const t0 = performance.now();
        const extractor = await pipeline("feature-extraction", MODEL_ID, {
          dtype,
          device,
          progress_callback: (p) => {
            if (p.status === "progress" && p.total) {
              setProgress(p.loaded, p.total, `加载模型 ${Math.round((p.loaded / p.total) * 100)}%`);
            }
          },
        });
        const loadMs = Math.round(performance.now() - t0);
        state.extractor = extractor;
        state.device = device;
        state.dtype = dtype;
        state.dim = extractor.model?.config?.hidden_size || 0;
        state.ready = true;
        hideProgress();
        const degraded = device !== "webgpu";
        ui.badgeDevice.textContent = degraded ? "后端：WASM（已降级）" : "后端：WebGPU";
        ui.badgeDevice.className = `badge ${degraded ? "badge-warn" : "badge-good"}`;
        ui.badgeDevice.title = degraded ? fallbackReason || "WebGPU 不可用，已自动降级到 WASM" : "使用 WebGPU 执行推理";
        ui.badgeDtype.textContent = DTYPE_LABEL[dtype] || dtype;
        log(
          `模型就绪：${MODEL_ID} · ${DTYPE_LABEL[dtype] || dtype} · ${device} · ${state.dim} 维 · 加载 ${loadMs} ms` +
            (degraded && fallbackReason ? ` · 降级原因：${fallbackReason}` : ""),
        );
        return extractor;
      } catch (error) {
        fallbackReason = `${device} ${dtype} 不可用（${String(error.message).slice(0, 80)}）`;
        console.warn("model attempt failed", device, dtype, error);
      }
    }
    hideProgress();
    throw new Error(`模型加载失败：${fallbackReason}`);
  })();
  try {
    return await state.loading;
  } finally {
    state.loading = null;
  }
}

async function embed(texts, kind) {
  if (!state.extractor) await loadModel("auto");
  const inputs = texts.map((t) => (kind === "query" ? QUERY_PREFIX + t : t));
  const output = await state.extractor(inputs, { pooling: "cls", normalize: true });
  const list = output.tolist();
  return Array.isArray(list[0]) ? list : [list];
}

// ---------------------------------------------------------------- chunking

function chunkText(text, max = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const clean = text.replace(/\r\n/g, "\n").trim();
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.replace(/\s+\n/g, "\n").trim()).filter(Boolean);
  const chunks = [];
  let buffer = "";
  const push = () => {
    if (!buffer.trim()) return;
    chunks.push(buffer.trim());
    buffer = chunks.length ? buffer.slice(Math.max(0, buffer.length - overlap)) : "";
  };
  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    if (paragraph.length > max) {
      if (buffer.trim()) push();
      const sentences = paragraph.split(/(?<=[。！？!?；;.])/);
      buffer = "";
      for (const sentence of sentences) {
        if ((buffer + sentence).length > max && buffer) push();
        buffer += sentence;
      }
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = "";
      }
      continue;
    }
    if ((buffer + "\n\n" + paragraph).length > max && buffer) push();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks.filter(Boolean);
}

// ----------------------------------------------------------------- network

async function api(pathname, body) {
  const response = await fetch(pathname, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function refreshState() {
  try {
    const info = await api("/api/state");
    ui.statChunks.textContent = info.chunks;
    ui.statDim.textContent = info.dimension;
    ui.collection.value = info.collection;
    ui.badgeDb.textContent = `seekdb：${info.collection}`;
    ui.badgeDb.className = "badge badge-good";
    const docs = await api("/api/docs");
    ui.statDocs.textContent = docs.total;
    ui.docList.innerHTML = docs.docs
      .map((doc) => `<li><span>${escapeHtml(doc.title || doc.docId)}</span><span>${doc.chunks} 块</span></li>`)
      .join("");
  } catch (error) {
    ui.badgeDb.textContent = "seekdb：未连接";
    ui.badgeDb.className = "badge badge-warn";
    log(`数据库未就绪：${error.message}（先运行 npm start）`);
  }
}

// ------------------------------------------------------------------ import

async function importDocs(docs) {
  if (!docs.length) return;
  await loadModel("auto");
  ui.btnImport.disabled = true;
  const startedAt = performance.now();
  let totalChunks = 0;
  let written = 0;
  try {
    const prepared = docs.map((doc) => ({ ...doc, chunks: chunkText(doc.text) }));
    totalChunks = prepared.reduce((sum, doc) => sum + doc.chunks.length, 0);
    setProgress(0, totalChunks, `切分完成：${docs.length} 篇 / ${totalChunks} 块，开始端侧向量化…`);

    let done = 0;
    const embedStart = performance.now();
    for (const doc of prepared) {
      const rows = [];
      for (let i = 0; i < doc.chunks.length; i += BATCH_SIZE) {
        const batch = doc.chunks.slice(i, i + BATCH_SIZE);
        // The title is part of the embedded text: a paragraph on its own often
        // loses the topic it belongs to, and that shows up as a neighbour from
        // an unrelated document ranking first.
        const vectors = await embed(batch.map((text) => `${doc.title}\n${text}`), "document");
        for (let k = 0; k < batch.length; k += 1) {
          rows.push({
            id: `${doc.id}#${i + k}`,
            docId: doc.id,
            title: doc.title,
            index: i + k,
            text: batch[k],
            embedding: vectors[k],
          });
        }
        done += batch.length;
        setProgress(done, totalChunks, `端侧向量化 ${done}/${totalChunks}`);
      }
      // One request per document keeps writes incremental: the knowledge base
      // stays queryable between imports.
      // Writes are incremental, but the index is refreshed once after the whole
      // batch: a refresh costs seconds, so doing it per document dominates the
      // import time (measured in tools/bench.mjs).
      const result = await api("/api/import", { chunks: rows, refresh: false });
      written += rows.length;
      ui.statChunks.textContent = result.chunks;
    }
    const embedMs = Math.round(performance.now() - embedStart);
    let refreshMs = 0;
    if (ui.refresh.checked) {
      const refreshed = await api("/api/refresh", {});
      refreshMs = Number(refreshed.ms) || 0;
    }
    await refreshState();
    log(
      `已写入 ${prepared.length} 篇 / ${written} 块：端侧向量化 ${embedMs} ms（${(written / (embedMs / 1000)).toFixed(1)} 块/秒）` +
        `，索引刷新 ${refreshMs ? `${refreshMs} ms` : "未执行（可点「刷新索引」）"}，总计 ${Math.round(performance.now() - startedAt)} ms`,
    );
  } catch (error) {
    log(`导入失败：${error.message}`);
  } finally {
    ui.btnImport.disabled = false;
    hideProgress();
  }
}

function readFiles(files) {
  const readers = [...files].map(
    (file) =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve({
            id: file.name.replace(/\.[^.]+$/, ""),
            title: file.name.replace(/\.[^.]+$/, ""),
            text: String(reader.result || ""),
          });
        reader.onerror = () => resolve(null);
        reader.readAsText(file, "utf-8");
      }),
  );
  return Promise.all(readers).then((list) => list.filter((d) => d && d.text.trim().length > 0));
}

// ------------------------------------------------------------------ search

async function search() {
  const query = ui.query.value.trim();
  if (!query) return;
  ui.btnSearch.disabled = true;
  ui.timing.textContent = "端侧向量化中…";
  try {
    const t0 = performance.now();
    const [vector] = await embed([query], "query");
    const embedMs = performance.now() - t0;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const result = await api("/api/search", {
      query,
      embedding: vector,
      topK: Number(ui.topK.value) || 6,
      mode,
    });
    renderHits(result.hits, query);
    ui.timing.textContent = `端侧 embedding ${embedMs.toFixed(1)} ms · 库内检索 ${result.dbMs} ms · ${result.fusedBy} · 命中 ${result.hits.length} 条`;
  } catch (error) {
    ui.timing.textContent = `检索失败：${error.message}`;
    ui.hits.innerHTML = "";
  } finally {
    ui.btnSearch.disabled = false;
  }
}

function renderHits(hits, query) {
  if (!hits.length) {
    ui.hits.innerHTML = '<div class="empty">没有命中。换个说法，或者先导入语料。</div>';
    return;
  }
  const max = Math.max(...hits.map((h) => (typeof h.score === "number" ? Math.abs(h.score) : 0)), 1e-6);
  ui.hits.innerHTML = hits
    .map((hit, index) => {
      const strength = typeof hit.score === "number" ? Math.max(4, Math.round((Math.abs(hit.score) / max) * 100)) : 0;
      const scoreText = typeof hit.score === "number" ? hit.score.toFixed(4) : "—";
      return `<li class="hit">
        <div class="hit-head">
          <span class="rank">#${index + 1}</span>
          <span class="hit-title">${escapeHtml(hit.title || hit.docId)}</span>
          <span class="hit-meta">块 ${hit.chunkIndex ?? "-"} · 融合分 ${scoreText}</span>
        </div>
        <p class="hit-text">${highlight(hit.text, query)}</p>
        <div class="bar-mini"><i style="width:${strength}%"></i></div>
      </li>`;
    })
    .join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function highlight(text, query) {
  const escaped = escapeHtml(text);
  const needles = new Set();
  for (const token of query.split(/[\s,，。？?！!、；;：:]+/)) {
    if (token.length >= 2) needles.add(token);
  }
  for (const run of query.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i += 1) needles.add(run.slice(i, i + 2));
  }
  let output = escaped;
  for (const needle of [...needles].sort((a, b) => b.length - a.length).slice(0, 40)) {
    const safe = escapeHtml(needle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
  }
  return output;
}

// -------------------------------------------------------------------- wire

ui.drop.addEventListener("click", () => ui.file.click());
ui.drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  ui.drop.classList.add("over");
});
ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("over"));
ui.drop.addEventListener("drop", async (event) => {
  event.preventDefault();
  ui.drop.classList.remove("over");
  const docs = await readFiles(event.dataTransfer.files);
  await importDocs(docs);
});
ui.file.addEventListener("change", async () => {
  const docs = await readFiles(ui.file.files);
  ui.file.value = "";
  await importDocs(docs);
});

ui.btnImport.addEventListener("click", async () => {
  const text = ui.paste.value.trim();
  if (!text) {
    log("先粘贴文本或选择文件。");
    return;
  }
  const lines = text.split("\n");
  const title = lines[0].slice(0, 40);
  const doc = { id: `paste-${Date.now().toString(36)}`, title, text };
  ui.paste.value = "";
  await importDocs([doc]);
});

ui.btnSample.addEventListener("click", async () => {
  try {
    const response = await fetch("./corpus/seed.json");
    const docs = await response.json();
    await importDocs(docs);
  } catch (error) {
    log(`示例语料加载失败：${error.message}`);
  }
});

ui.btnSearch.addEventListener("click", search);
ui.query.addEventListener("keydown", (event) => {
  if (event.key === "Enter") search();
});

ui.btnSwitch.addEventListener("click", async () => {
  try {
    const info = await api("/api/collection", { action: "switch", name: ui.collection.value.trim() });
    localStorage.setItem("kb.collection", info.collection);
    ui.hits.innerHTML = "";
    await refreshState();
    log(`已切换到集合 ${info.collection}（${info.chunks} 块）`);
  } catch (error) {
    log(`切换失败：${error.message}`);
  }
});

ui.btnRefresh.addEventListener("click", async () => {
  try {
    const result = await api("/api/refresh", {});
    log(`索引已刷新：${result.ms} ms，当前 ${result.chunks} 块可检索。`);
    await refreshState();
  } catch (error) {
    log(`刷新失败：${error.message}`);
  }
});

ui.btnReset.addEventListener("click", async () => {
  if (!confirm(`清空集合 ${ui.collection.value}？`)) return;
  try {
    await api("/api/reset", {});
    ui.hits.innerHTML = "";
    ui.timing.textContent = "";
    await refreshState();
    log("集合已清空。");
  } catch (error) {
    log(`清空失败：${error.message}`);
  }
});

const saved = localStorage.getItem("kb.collection");
if (saved && saved !== ui.collection.value) {
  ui.collection.value = saved;
  api("/api/collection", { action: "switch", name: saved }).catch(() => {});
}

ui.backend.addEventListener("change", async () => {
  const mode = ui.backend.value;
  const label = mode === "auto" ? "自动" : mode === "webgpu" ? "WebGPU（FP16）" : "WASM（INT8）";
  if (state.ready && !confirm(`切换到 ${label} 会改变向量空间，当前库里的向量需要重新导入。是否清空当前集合并重建？`)) {
    ui.backend.value = state.device === "webgpu" ? "webgpu" : "wasm";
    return;
  }
  try {
    await api("/api/reset", {});
    ui.hits.innerHTML = "";
    await refreshState();
    await loadModel(mode);
    log(`已切换到 ${label}，库已重建，请重新导入语料。`);
  } catch (error) {
    log(`切换后端失败：${error.message}`);
  }
});

await refreshState();
loadModel("auto").catch((error) => log(error.message));

// Small handle for the e2e script and for the browser console; it only exposes
// what the page already does.
window.__kb = { embed, loadModel, state, chunkText };
