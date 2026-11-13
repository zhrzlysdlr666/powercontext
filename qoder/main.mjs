// StudyLens entries.
//
//   node main.mjs            自检模式：起服务 → 打接口 → 打印 SELFCHECK PASS → 退出码 0（数秒结束）
//   node main.mjs --serve    服务模式：常驻，http://127.0.0.1:3000（或 $PORT）
//
// 两种模式跑的是同一套检索代码（src/serve.mjs 里的 BM25 与导出数据），不是两套实现。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = join(HERE, 'src', 'serve.mjs');
const argv = process.argv.slice(2);
const wantServe = argv.includes('--serve') || argv.includes('-s');

if (wantServe) {
  await import('./src/serve.mjs');
} else {
  await selfCheck();
}

async function selfCheck() {
  const PORT = 3000 + Math.floor(Math.random() * 600);
  const child = spawn(process.execPath, [SERVE], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failed = 0;
  const ok = (name, extra = '') => console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`);
  const bad = (name, why) => {
    failed++;
    console.log(`  FAIL ${name} — ${why}`);
  };

  try {
    console.log('StudyLens selfcheck');
    let health = null;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) { health = await r.json(); break; }
      } catch {}
      await sleep(100);
    }
    if (health && health.ok) ok('server up', `chunks=${health.chunks} docs=${health.docs}`);
    else throw new Error('server did not answer /api/health\n' + log);

    const cases = [
      ['中文分词器怎么选', 'seekdb'],
      ['倒排索引', 'bm25'],
      ['切片策略 语义边界', 'seekdb'],
      ['BM25 相关度打分', 'seekdb'],
    ];
    for (const [q, expectEngine] of cases) {
      const r = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`);
      const body = await r.json();
      if (r.ok && body.total > 0 && (!expectEngine || body.engine === expectEngine)) {
        ok(`search "${q}"`, `${body.total} hits, ${body.latencyMs} ms, engine=${body.engine}, top=${body.hits[0].heading}`);
      } else {
        bad(`search "${q}"`, `status=${r.status} total=${body.total} engine=${body.engine}`);
      }
    }

    const page = await fetch(`${base}/`);
    const html = await page.text();
    if (page.ok && html.includes('StudyLens') && html.includes('id="q"')) ok('page served', `${html.length} bytes`);
    else bad('page served', `status=${page.status} len=${html.length}`);

    const data = await fetch(`${base}/data/index.json`);
    const idx = await data.json();
    if (idx.chunks && idx.chunks.length) ok('index export', `${idx.chunks.length} chunks / ${idx.documents.length} docs`);
    else bad('index export', 'empty chunks');
  } catch (e) {
    bad('selfcheck', String(e.message || e).split('\n')[0]);
  } finally {
    child.kill();
  }

  console.log(failed ? `\nSELFCHECK FAILED (${failed})` : '\nSELFCHECK PASS');
  process.exitCode = failed ? 1 : 0;
}
