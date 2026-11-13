// One-command self check: boot the server on a free port, call the two API
// endpoints, print the JSON, exit non-zero if the main function does not answer.
//   node src/smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 3000 + Math.floor(Math.random() * 500);

const child = spawn(process.execPath, [join(HERE, 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not answer /api/health\n' + log);
}

try {
  const health = await waitUp();
  console.log('GET /api/health ->', JSON.stringify(health));

  const q = process.argv[2] || '倒排索引';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(q)}`);
  const body = await r.json();
  console.log(`GET /api/search?q=${q} ->`, JSON.stringify({
    engine: body.engine, total: body.total, latencyMs: body.latencyMs,
    first: body.hits && body.hits[0] && body.hits[0].heading,
  }));
  if (!health.ok || !body.total) throw new Error('main function returned no hits');

  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  console.log('GET / ->', page.status, page.headers.get('content-type'));
  if (page.status !== 200) throw new Error('page not served');
  console.log('SMOKE OK');
} catch (e) {
  console.error('SMOKE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
