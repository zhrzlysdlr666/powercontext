// 仓库根入口：等价于 `cd qoder && node main.mjs`
//   node main.mjs            自检（真连 seekdb，打印 SELFCHECK PASS）
//   node main.mjs --serve    服务（8899，同时兜底 3000/8000/5000/8080）
// 依赖 seekdb 客户端（pip install -r requirements.txt），Node 只负责转发给 Python 实现。
import './qoder/main.mjs';
