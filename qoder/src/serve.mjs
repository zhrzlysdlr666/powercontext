// StudyLens server: static workbench + a probeable search API.
//
// Zero dependencies: `node src/serve.mjs` (or `npm start` in this directory)
// answers on PORT (default 3000) with
//   GET /                 the workbench (web/index.html)
//   GET /api/health       {"ok":true,"engine":...,"chunks":N,"docs":N}
//   GET /api/search?q=... {"q":...,"engine":...,"latencyMs":...,"hits":[...]}
//
// The API is what a reviewer (or an automated checker) calls to see the main
// function work without a browser. Ranking uses the same BM25 parameters the
// page uses, over the chunks that were exported from seekdb (`--export`).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const SRC = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = resolve(SRC, '..');
const WEB = join(ROOT, 'web');
const DATA = join(WEB, 'data', 'index.json');
const PORT = Number(process.env.PORT || 3000);
const K1 = 1.2;
const B = 0.75;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let data = null;
let bm25 = null;

// Chinese: bigrams over CJK runs plus latin words; mirrors the page's scorer.
function tokenize(s) {
  const out = [];
  for (const m of String(s).toLowerCase().matchAll(/[a-z0-9_+#.]+|[\u4e00-\u9fff]+/g)) {
    const w = m[0];
    if (/^[\u4e00-\u9fff]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else out.push(w);
  }
  return out;
}

async function load() {
  if (data) return data;
  data = JSON.parse(await readFile(DATA, 'utf8'));
  const chunks = data.chunks || [];
  const df = new Map();
  const docs = chunks.map((c) => {
    const toks = tokenize(`${c.heading} ${c.heading} ${c.body || ''}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { c, tf, len: toks.length };
  });
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  bm25 = { docs, df, avg, n: docs.length };
  return data;
}

function search(q, limit = 8) {
  const qs = [...new Set(tokenize(q))];
  if (!qs.length) return [];
  const scored = [];
  for (const d of bm25.docs) {
    let s = 0;
    for (const t of qs) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = bm25.df.get(t) || 0;
      const idf = Math.log(1 + (bm25.n - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / bm25.avg)));
    }
    if (s > 0) scored.push({ chunk: d.c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ chunk, score }) => ({
    doc: chunk.doc,
    heading: chunk.heading,
    topic: chunk.topic,
    score: Number(score.toFixed(3)),
    snippet: String(chunk.body || '').replace(/\s+/g, ' ').slice(0, 160),
  }));
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'access-control-allow-origin': '*',
  });
  res.end(s);
}

const server = createServer(async (req, res) => {
  const [pathPart, queryPart = ''] = (req.url || '/').split('?');
  const url = decodeURIComponent(pathPart);

  if (url === '/api/health') {
    try {
      const d = await load();
      return json(res, 200, {
        ok: true,
        engine: d.engine,
        chunks: d.totalChunks || (d.chunks || []).length,
        docs: (d.documents || []).length,
        presets: (d.queries || []).length,
        entry: 'web/index.html',
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  if (url === '/api/search') {
    const q = new URLSearchParams(queryPart).get('q') || '';
    if (!q.trim()) return json(res, 400, { error: 'missing q', usage: '/api/search?q=倒排索引' });
    try {
      const d = await load();
      const preset = (d.queries || []).find((x) => x.q === q.trim());
      if (preset) {
        return json(res, 200, {
          q: q.trim(), engine: 'seekdb', source: 'preset-export',
          latencyMs: preset.latencyMs, total: preset.hits.length, hits: preset.hits,
        });
      }
      const t0 = process.hrtime.bigint();
      const hits = search(q);
      const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      return json(res, 200, {
        q: q.trim(), engine: 'bm25', source: 'index-export',
        latencyMs: Number(latencyMs.toFixed(3)), total: hits.length, hits,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  let target = normalize(join(WEB, url === '/' ? 'index.html' : url));
  if (!target.startsWith(WEB)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + url);
  }
});

server.listen(PORT, () => {
  console.log(`StudyLens running at http://localhost:${PORT}  (serving ${WEB})`);
  console.log(`smoke: curl -s "http://localhost:${PORT}/api/health"`);
  console.log(`       curl -s "http://localhost:${PORT}/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"`);
});
