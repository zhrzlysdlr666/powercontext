// 浏览器端：本地向量化（WebGPU 优先，自动降级 WASM）+ 调 seekdb 做混合检索。
import { pipeline, env } from '/vendor/transformers/transformers.min.js';

const MODEL_ID = 'bge-small-zh-v1.5';
const DTYPE = 'q8'; // INT8 量化模型（model_quantized.onnx），体积 24.0 MB

// 全部资源本地提供，运行期不访问任何远端推理服务。
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
// 服务端已开启 COOP/COEP，跨源隔离成立时 WASM 后端可多线程。
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
  : 1;

const $ = (id) => document.getElementById(id);
const t = () => performance.now();
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const median = (xs) => {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

let embedder = null;
let backend = 'unknown';
let loadMs = 0;
let probeReport = '';
let backendReason = '';
// 当前知识库（collection）：持久化在 localStorage，刷新页面后仍指向同一个集合。
let currentKb = localStorage.getItem('kb.current') || 'default';

// WebGPU 相对 WASM 的容忍倍数：真实 GPU 通常快 3–10 倍；
// 若 WebGPU 反而慢过 3 倍，多半是软件光栅化（无 GPU 或无头环境），此时按实测降级。
const WEBGPU_SLOWDOWN_TOLERANCE = 3;

function setBadge(text, cls) {
  const el = $('backend');
  el.textContent = text;
  el.className = `badge ${cls}`;
}

// 后端策略：默认 auto（优先 WebGPU，不可用/明显更慢才降级）；
// ?backend=webgpu / ?backend=wasm 强制指定，用于验收「WebGPU 可用与不可用」两条路径。
const MODE = new URLSearchParams(location.search).get('backend') || 'auto';
const PROBE_TEXT = '知识库检索的向量化延迟探测文本';
// 探测结果缓存：同一浏览器 7 天内复用上次决策，省掉每次访问 ~0.7 s 的双后端初始化 + 探测。
const CACHE_KEY = 'kb.backendCache';
const CACHE_TTL = 7 * 24 * 3600 * 1000;

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || !c.device || Date.now() - c.at > CACHE_TTL) return null;
    return c;
  } catch { return null; }
}
function writeCache(device, ratio) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ device, ratio, at: Date.now() })); } catch {}
}

async function timeOne(pipe, text) {
  const started = t();
  await pipe([text], { pooling: 'mean', normalize: true });
  return t() - started;
}

async function probeBackend(pipe) {
  await timeOne(pipe, PROBE_TEXT); // 预热，不计入
  const samples = [];
  for (let i = 0; i < 3; i += 1) samples.push(await timeOne(pipe, PROBE_TEXT));
  return median(samples);
}

async function getEmbedder() {
  if (embedder) return embedder;
  const start = t();
  const tried = [];
  const hasGpu = Boolean(navigator.gpu);
  const cache = MODE === 'auto' ? readCache() : null;

  // 0) 命中缓存且条件依然成立：直接按上次结论初始化单个后端，跳过探测
  if (cache) {
    const ok = cache.device === 'webgpu' ? hasGpu : true;
    if (ok) {
      try {
        const pipe = await pipeline('feature-extraction', MODEL_ID, { device: cache.device, dtype: DTYPE });
        tried.push({ device: cache.device, ms: NaN, pipe });
        embedder = pipe;
        backend = cache.device;
        backendReason = `沿用上次探测结果（${cache.device} 更快，比值 ${Number(cache.ratio || 1).toFixed(1)}×），本次跳过探测`;
        probeReport = '缓存命中';
      } catch {
        try { localStorage.removeItem(CACHE_KEY); } catch {}
      }
    }
  }

  // 1) 尝试 WebGPU（除了显式要求 wasm，一律先试 WebGPU）
  if (!embedder && MODE !== 'wasm') {
    if (!hasGpu) {
      backendReason = '浏览器不支持 WebGPU（navigator.gpu 缺失），已自动降级到 WASM';
    } else {
      try {
        const gpuPipe = await pipeline('feature-extraction', MODEL_ID, { device: 'webgpu', dtype: DTYPE });
        const gpuMs = await probeBackend(gpuPipe);
        tried.push({ device: 'webgpu', ms: gpuMs, pipe: gpuPipe });
        if (MODE === 'webgpu') {
          embedder = gpuPipe;
          backend = 'webgpu';
          backendReason = '按 ?backend=webgpu 强制指定';
        }
      } catch (err) {
        console.warn('WebGPU 初始化失败：', err);
        const msg = String((err && err.message) || err).slice(0, 120);
        tried.push({ device: 'webgpu', ms: Infinity, error: msg });
        backendReason = `WebGPU 初始化失败（${msg}），已自动降级到 WASM`;
        if (MODE === 'webgpu') throw err;
      }
    }
  }

  // 2) 需要时初始化 WASM 作为兜底 / 对照
  if (!embedder) {
    const wasmPipe = await pipeline('feature-extraction', MODEL_ID, { device: 'wasm', dtype: DTYPE });
    const wasmMs = await probeBackend(wasmPipe);
    tried.push({ device: 'wasm', ms: wasmMs, pipe: wasmPipe });

    if (MODE === 'wasm') {
      embedder = wasmPipe;
      backend = 'wasm';
      backendReason = '按 ?backend=wasm 强制指定（验证降级路径）';
    } else {
      const gpu = tried.find((x) => x.device === 'webgpu' && x.pipe);
      if (gpu && gpu.ms <= wasmMs * WEBGPU_SLOWDOWN_TOLERANCE) {
        writeCache('webgpu', wasmMs / gpu.ms);
        // 优先 WebGPU：只要不比 WASM 慢一个量级，就用 GPU 后端
        embedder = gpu.pipe;
        backend = 'webgpu';
        backendReason = `WebGPU 可用且探测延迟 ${gpu.ms.toFixed(1)} ms/次，符合优先策略`;
      } else if (gpu) {
        writeCache('wasm', gpu.ms / wasmMs);
        embedder = wasmPipe;
        backend = 'wasm';
        backendReason =
          `WebGPU 可用但实测 ${gpu.ms.toFixed(1)} ms/次，比 WASM 慢 ` +
          `${(gpu.ms / wasmMs).toFixed(1)} 倍（疑似软件光栅化），按实测降级到 WASM`;
      } else {
        embedder = wasmPipe;
        backend = 'wasm';
        backendReason = backendReason || '未获得可用的 WebGPU 后端，使用 WASM';
      }
    }
  }

  for (const item of tried) {
    if (item.pipe && item.pipe !== embedder && item.pipe.dispose) {
      try { await item.pipe.dispose(); } catch {}
    }
  }
  probeReport = cache && embedder && tried.length === 1
    ? `沿用缓存（${backend}）`
    : tried.map((x) => `${x.device} ${Number.isFinite(x.ms) ? `${x.ms.toFixed(1)} ms/次` : '未探测'}`).join(' vs ');

  loadMs = t() - start;
  const threads = env.backends.onnx.wasm.numThreads;
  const label =
    backend === 'webgpu'
      ? `推理后端：WebGPU · ${DTYPE}`
      : `推理后端：WASM · ${DTYPE} · ${threads} 线程`;
  setBadge(label, backend === 'webgpu' ? 'badge-ok' : 'badge-warn');
  $('t-load').textContent = fmt(loadMs);
  $('backendWhy').textContent = `${backendReason}｜探测：${probeReport}｜跨源隔离：${self.crossOriginIsolated ? '已启用' : '未启用'}`;
  return embedder;
}

async function embed(texts, batchSize) {
  const pipe = await getEmbedder();
  const vectors = [];
  const started = t();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const out = await pipe(batch, { pooling: 'mean', normalize: true });
    const list = out.tolist();
    for (const v of list) vectors.push(v);
    const done = Math.min(texts.length, i + batch.length);
    $('bar').style.width = `${(done / texts.length) * 100}%`;
  }
  return { vectors, embedMs: t() - started };
}

// 语料切块：按空行分段，超长再按句号/换行切；每块 40–360 字。
function chunk(text, source) {
  const blocks = String(text)
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let seq = 0;
  for (const block of blocks) {
    const parts = block.length <= 360 ? [block] : block.split(/(?<=[。！？；\n])/);
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length > 360 && buf) {
        out.push(buf.trim());
        buf = '';
      }
      buf += p;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out
    .filter((s) => s.length >= 12)
    .map((s) => ({
      id: `${source || 'paste'}#${seq}`,
      title: s.slice(0, 28) + (s.length > 28 ? '…' : ''),
      text: s,
      source: source || 'paste',
      seq: seq++,
    }));
}

async function refreshStats() {
  const r = await fetch(`/api/health?kb=${encodeURIComponent(currentKb)}`).then((x) => x.json());
  $('docs').textContent = `知识库「${r.kb}」：${r.docs} 块 · ${r.dim} 维 · 向量索引 ${r.vector_index ? '已建' : '未建'}`;
  // 同步知识库下拉列表（保留当前选择）
  const sel = $('kb');
  const list = (r.collections || []).map((c) => c.kb);
  if (!list.includes(currentKb)) list.unshift(currentKb);
  sel.innerHTML = list
    .map((k) => `<option value="${escapeHtml(k)}"${k === currentKb ? ' selected' : ''}>${escapeHtml(k)}（${(r.collections || []).find((c) => c.kb === k)?.docs ?? 0}）</option>`)
    .join('');
  return r;
}

function switchKb(name) {
  currentKb = String(name || 'default').slice(0, 64) || 'default';
  localStorage.setItem('kb.current', currentKb);
  $('results').innerHTML = '';
  return refreshStats();
}

async function doImport() {
  const btn = $('btnImport');
  btn.disabled = true;
  $('importLog').textContent = '';
  try {
    const text = $('corpus').value;
    const docs = chunk(text, 'paste');
    if (!docs.length) throw new Error('没有可用文本（每段至少 12 字）');
    const batchSize = Math.max(1, Number($('batch').value) || 8);
    const { vectors, embedMs } = await embed(docs.map((d) => d.text), batchSize);
    docs.forEach((d, i) => { d.vector = vectors[i]; });

    const writeStart = t();
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kb: currentKb, docs }),
    }).then((x) => x.json());
    if (res.error) throw new Error(res.error);
    const writeMs = t() - writeStart;

    $('t-embed').textContent = `${fmt(embedMs)} · ${docs.length} 块 · ${(docs.length / (embedMs / 1000)).toFixed(1)} 块/s`;
    $('t-write').textContent = `${fmt(writeMs)}（服务端 ${fmt(res.db_write_ms)}）`;
    $('importLog').textContent =
      `已写入「${res.kb}」${res.inserted} 块，该库共 ${res.total} 块。向量化 ${fmt(embedMs)}，写入 ${fmt(writeMs)}。` +
      `\n提交后立即检索可见（seekdb 的全文与向量索引随事务生效），无需手动刷新。`;
    await refreshStats();
  } catch (err) {
    $('importLog').textContent = `导入失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function queryOnce(qtext, k, batchSize = 1) {
  const e2eStart = t();
  const { vectors, embedMs } = await embed([qtext], batchSize);
  $('t-qembed').textContent = fmt(embedMs);
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kb: currentKb, vector: vectors[0], text: qtext, k }),
  }).then((x) => x.json());
  if (res.error) throw new Error(res.error);
  $('t-query').textContent = `${fmt(res.db_query_ms)}（单条 SQL，含向量与全文两路打分）`;
  const e2e = t() - e2eStart;
  $('t-e2e').textContent = fmt(e2e);
  return { ...res, embedMs, e2eMs: e2e };
}

function render(hits) {
  const ol = $('results');
  ol.innerHTML = '';
  hits.forEach((h, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="head">
        <span><span class="title">${i + 1}. ${escapeHtml(h.title || h.id)}</span></span>
        <span class="metrics">score ${h.score.toFixed(3)} · 全文 ${h.ft_score.toFixed(3)} · L2 ${h.l2.toFixed(3)}</span>
      </div>
      <p>${escapeHtml(h.text).slice(0, 300)}</p>`;
    ol.appendChild(li);
  });
  if (!hits.length) ol.innerHTML = '<li><p>没有命中，换一种说法再试。</p></li>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function doSearch() {
  const btn = $('btnSearch');
  btn.disabled = true;
  try {
    const qtext = $('q').value.trim();
    if (!qtext) throw new Error('请输入查询');
    await getEmbedder();
    const res = await queryOnce(qtext, Number($('k').value) || 5);
    render(res.hits);
  } catch (err) {
    $('results').innerHTML = `<li><p>检索失败：${escapeHtml(err.message)}</p></li>`;
  } finally {
    btn.disabled = false;
  }
}

async function doBench() {
  const btn = $('btnBench');
  btn.disabled = true;
  const log = $('benchLog');
  log.textContent = '基准运行中（10 次查询，首次含预热之外的重复调用）…';
  try {
    await getEmbedder();
    const queries = [
      '云服务订阅收入的增长情况',
      '净利润下滑的原因',
      '研发投入与招聘方向',
      '数据持久化与崩溃恢复',
      '向量索引如何维护',
    ];
    const rows = [];
    for (let i = 0; i < 10; i += 1) {
      const q = queries[i % queries.length];
      const r = await queryOnce(q, 5);
      rows.push({ q, qembed: r.embedMs, db: r.db_query_ms, e2e: r.e2eMs });
    }
    const m = (key) => median(rows.map((r) => r[key]));

    // 批大小扫描：同一批语料在不同 batchSize 下重新向量化，用于说明批处理的优化效果
    const corpus = chunk($('corpus').value || '', 'bench');
    const sweep = [];
    if (corpus.length >= 8) {
      for (const bs of [1, 2, 4, 8, 16, 32]) {
        await embed(corpus.slice(0, 4).map((d) => d.text), bs); // 预热该 batch 形状
        const started = t();
        await embed(corpus.map((d) => d.text), bs);
        const ms = t() - started;
        sweep.push({ bs, ms, per: ms / corpus.length });
      }
    }
    $('bar').style.width = '0%';
    $('batchLog').textContent = sweep.length
      ? `批大小扫描（${corpus.length} 块，${backend}）\n` +
        sweep.map((x) => `  batch=${String(x.bs).padStart(2)}  ${fmt(x.ms)}  单项 ${x.per.toFixed(2)} ms  ${(1000 / x.per).toFixed(1)} 块/s`).join('\n') +
        `\n最佳：batch=${sweep.reduce((a, b) => (b.per < a.per ? b : a)).bs}（${(1000 / sweep.reduce((a, b) => (b.per < a.per ? b : a)).per).toFixed(1)} 块/s）`
      : '';

    log.textContent =
      `模型加载 ${fmt(loadMs)} · 后端 ${backend}\n` +
      `查询向量化 中位数 ${fmt(m('qembed'))}\n` +
      `seekdb 混合检索 中位数 ${fmt(m('db'))}\n` +
      `端到端 中位数 ${fmt(m('e2e'))}\n` +
      rows.map((r, i) => `  #${i + 1} e2e ${fmt(r.e2e)} (embed ${fmt(r.qembed)} / db ${fmt(r.db)})`).join('\n');
  } catch (err) {
    log.textContent = `基准失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function doReset() {
  await fetch('/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kb: currentKb }),
  });
  await refreshStats();
  $('results').innerHTML = '';
  $('importLog').textContent = `知识库「${currentKb}」已清空（其他知识库不受影响）。`;
}

$('file').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  const texts = await Promise.all(files.map((f) => f.text()));
  $('corpus').value = texts.join('\n\n');
});

$('kb').addEventListener('change', (e) => switchKb(e.target.value));
$('btnNewKb').addEventListener('click', async () => {
  const name = prompt('新建知识库名称（英文/数字，2-32 字）', 'notes-' + Date.now().toString(36).slice(-4));
  if (!name) return;
  await switchKb(name.trim());
  $('importLog').textContent = `已切换到新知识库「${currentKb}」，导入的文档只会进入这个集合。`;
});
$('btnImport').addEventListener('click', doImport);
$('btnSearch').addEventListener('click', doSearch);
$('btnBench').addEventListener('click', doBench);
$('btnReset').addEventListener('click', doReset);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

refreshStats().catch(() => {});
getEmbedder()
  .then(() => console.log(`[kb] backend=${backend} load=${loadMs.toFixed(0)}ms`))
  .catch((err) => {
    setBadge('推理后端：模型加载失败', 'badge-warn');
    console.error(err);
  });
