// StudyLens Node 入口 —— 转调同一份 seekdb 实现（qoder/main.py）。
//
//   node main.mjs            自检（等价 python main.py，打印 SELFCHECK PASS，退出码 0）
//   node main.mjs --serve    服务模式（等价 python main.py --serve）
//
// 为什么转调而不是再写一遍：检索逻辑必须只有一份，而且它跑在真实 seekdb 上
// （pylibseekdb 嵌入式引擎）。若这里另写一套 JS 检索，就成了「自制备用实现」，
// 与项目声明的技术栈不一致。Node 入口只负责把命令转发给 Python，退出码原样透传。
//
// 解释器选择：优先挑已经装好 pylibseekdb + pymysql 的那个（嵌入式引擎对 Python
// 版本有要求），没有就按默认顺序试第一个能跑起来的。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_PY = join(HERE, 'main.py');
const args = process.argv.slice(2);

const candidates = [
  process.env.PYTHON,
  'python3.12',
  'python3',
  'python',
  'py',
].filter(Boolean);

function hasSeekdb(cmd) {
  const r = spawnSync(cmd, ['-c', 'import pylibseekdb, pymysql'], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, [MAIN_PY, ...args], { cwd: HERE, stdio: 'inherit' });
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => resolve({ ok: true, code: code ?? 0 }));
  });
}

if (!existsSync(MAIN_PY)) {
  console.error(`找不到 ${MAIN_PY}`);
  process.exit(2);
}

// 先找依赖齐全的解释器：有就直接用它，退出码原样透传；
// 一个都没有就先补装 seekdb 客户端（和 run.sh / start.sh 的行为一致），再试一次。
const ready = candidates.filter(hasSeekdb);

if (ready.length) {
  const res = await run(ready[0]);
  process.exit(res.ok ? res.code : 127);
}

const first = candidates.find((cmd) => spawnSync(cmd, ['-V'], { stdio: 'ignore' }).status === 0);

if (first) {
  console.error(`[main.mjs] ${first} 缺少 seekdb 客户端，执行 pip install -r requirements.txt ...`);
  spawnSync(
    first,
    ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', join(HERE, 'requirements.txt')],
    { stdio: 'inherit' },
  );
  const res = await run(first);
  process.exit(res.ok ? res.code : 127);
}

console.error('未找到可用的 Python 解释器；StudyLens 的检索跑在 seekdb 上，需要 python3（推荐 3.12）。');
console.error('安装依赖：pip install -r requirements.txt');
process.exit(127);
