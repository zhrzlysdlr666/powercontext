// Labelled queries for the offline evaluation. Each one is answered by exactly
// one document in the sample corpus.
//
//   direct      — phrasing that shares vocabulary with the target document
//   paraphrase  — a user asking the same thing in their own words
//
// The second group is what actually tells the two search paths apart: keyword
// search needs the words, vector search does not.
export const QUERIES = [
  { q: "seekdb 是什么数据库", doc: "seekdb-overview", style: "direct" },
  { q: "RRF 融合为什么要看排名而不是分数", doc: "hybrid-rrf", style: "direct" },
  { q: "混合检索为什么不能让客户端自己拼两路结果", doc: "hybrid-rrf", style: "direct" },
  { q: "在浏览器本地跑模型有什么好处", doc: "on-device-inference", style: "direct" },
  { q: "INT8 量化能让模型小多少", doc: "quantization", style: "direct" },
  { q: "量化前后检索质量怎么对比", doc: "quantization", style: "direct" },
  { q: "WebGPU 不可用时怎么办", doc: "webgpu", style: "direct" },
  { q: "显卡加速和 CPU 加速差多少", doc: "webgpu", style: "direct" },
  { q: "长文档应该怎么切块", doc: "chunking", style: "direct" },
  { q: "导入后马上提问为什么查不到", doc: "incremental", style: "direct" },
  { q: "重复导入同一篇文档会怎样", doc: "incremental", style: "direct" },
  { q: "营业收入和净利润的口径区别", doc: "financial-report", style: "direct" },
  { q: "怎么测批大小对吞吐的影响", doc: "benchmark", style: "direct" },
  { q: "清理浏览器缓存会丢什么", doc: "browser-storage", style: "direct" },

  { q: "模型压到八位会不会把排序带偏", doc: "quantization", style: "paraphrase" },
  { q: "刚写好的笔记立刻搜不到是怎么回事", doc: "incremental", style: "paraphrase" },
  { q: "怎么确认计算真的发生在我的电脑上", doc: "on-device-inference", style: "paraphrase" },
  { q: "我的老显卡跑不动模型有别的办法吗", doc: "webgpu", style: "paraphrase" },
  { q: "一段话被从中间切断导致答案找不到", doc: "chunking", style: "paraphrase" },
  { q: "两家公司利润差很多怎么比较才公平", doc: "financial-report", style: "paraphrase" },
  { q: "一次算一条和一次算一批哪个快", doc: "benchmark", style: "paraphrase" },
  { q: "断网之后这个应用还能用吗", doc: "browser-storage", style: "paraphrase" },
];
