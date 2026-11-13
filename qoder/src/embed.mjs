// Inline web/data/index.json into web/index.html as a JSON script block, so the
// page has no extra network dependency. Run after `node src/search.mjs --export`.
import { readFileSync, writeFileSync } from 'node:fs';

const HTML = 'web/index.html';
const DATA = 'web/data/index.json';

const html = readFileSync(HTML, 'utf8');
const json = readFileSync(DATA, 'utf8').trim().replace(/<\//g, '<\\/');
const block = `<script id="index-data" type="application/json">${json}</script>`;

const start = html.indexOf('<script id="index-data"');
let out;
if (start !== -1) {
  const end = html.indexOf('</script>', start) + '</script>'.length;
  out = html.slice(0, start) + block + html.slice(end);
} else {
  const at = html.indexOf('const state = { data: null');
  if (at === -1) throw new Error('anchor not found in ' + HTML);
  const tag = html.lastIndexOf('<script', at);
  const cut = tag === -1 ? at : tag;
  out = html.slice(0, cut) + block + '\n\n' + html.slice(cut);
}

writeFileSync(HTML, out, 'utf8');
console.log('inlined', json.length, 'bytes of index.json into', HTML);
