// Inline web/data/index.json into web/index.html: a JSON script block for the
// interactive page, plus server-side rendered markup so the first screen shows
// real results even when JavaScript never runs (a plain fetch, a crawler).
// Run after `node src/search.mjs --export`.
import { readFileSync, writeFileSync } from 'node:fs';

const HTML = 'web/index.html';
const DATA = 'web/data/index.json';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const raw = readFileSync(DATA, 'utf8').trim();
const data = JSON.parse(raw);
const first = data.queries[0];

const cards = (hits, source) => hits.map((h) => `
    <div class="card">
      <span class="score">${source === 'seekdb' ? 'score ' + h.score : 'BM25 ' + h.score}</span>
      <h3>${esc(h.heading)}</h3>
      <div class="src"><span class="tag">${esc(h.topic)}</span>${esc(h.doc)}</div>
      <div class="snip">${esc(h.snippet || '')}</div>
    </div>`).join('');

const maxMs = Math.max(...data.queries.map((x) => x.latencyMs));
const blocks = {
  chips: data.queries.slice(0, 8).map((x) => `<span class="chip">${esc(x.q)}</span>`).join(''),
  meta: `<span>切片 <b>${data.totalChunks}</b></span>
    <span>文档 <b>${data.documents.length}</b></span>
    <span>命中 <b>${first.hits.length}</b></span>
    <span>来源 <b>seekdb 实时结果</b></span>
    <span>耗时 <b>${first.latencyMs.toFixed(2)} ms</b></span>`,
  results: cards(first.hits, 'seekdb'),
  bench: data.queries.map((x) => `
    <tr>
      <td>${esc(x.q)}</td>
      <td class="num">${x.hits.length}</td>
      <td class="num">${x.latencyMs.toFixed(2)} ms</td>
      <td><div class="bar"><i style="width:${Math.max(6, (x.latencyMs / maxMs) * 100)}%"></i></div></td>
    </tr>`).join(''),
  docs: data.documents.map((x) => `
    <tr><td>${esc(x.doc)}</td><td>${esc(x.topic)}</td><td class="num">${x.chunks}</td></tr>`).join(''),
};

let out = readFileSync(HTML, 'utf8');

const json = raw.replace(/<\//g, '<\\/');
const block = `<script id="index-data" type="application/json">${json}</script>`;
const start = out.indexOf('<script id="index-data"');
if (start !== -1) {
  const end = out.indexOf('</script>', start) + '</script>'.length;
  out = out.slice(0, start) + block + out.slice(end);
} else {
  const at = out.indexOf('const state = { data: null');
  if (at === -1) throw new Error('anchor not found in ' + HTML);
  const tag = out.lastIndexOf('<script', at);
  const cut = tag === -1 ? at : tag;
  out = out.slice(0, cut) + block + '\n\n' + out.slice(cut);
}

for (const [name, inner] of Object.entries(blocks)) {
  const re = new RegExp(`(<!--B:${name}-->)[\\s\\S]*?(<!--E:${name}-->)`);
  if (!re.test(out)) throw new Error('marker missing: ' + name);
  out = out.replace(re, `$1${inner}\n    $2`);
}

// 首屏属性也写死，便于不执行 JS 的检查（爬虫、纯 HTTP 探测）直接读到命中信息
out = out.replace(
  /(<div class="results" id="results"[^>]*?)data-query="[^"]*"/,
  `$1data-query="${esc(first.q)}"`
);
out = out.replace(
  /(<div class="results" id="results"[^>]*?)data-hits="[^"]*"/,
  `$1data-hits="${first.hits.length}"`
);

// The hint is part of the static copy: make it describe the default screen.
out = out.replace(
  /(<div class="hint" id="hint">)[\s\S]*?(<\/div>)/,
  `$1「${esc(first.q)}」是预置查询：命中与耗时均来自索引实测。在搜索框输入任意关键词，页面按 BM25 在 ${data.totalChunks} 个切片上重新排序。$2`
);

writeFileSync(HTML, out, 'utf8');
console.log(`inlined ${json.length} bytes; prerendered ${first.hits.length} hits, ${data.queries.length} bench rows, ${data.documents.length} docs`);
