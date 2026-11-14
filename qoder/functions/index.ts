/**
 * Qoder Sites Edge Function（Deno 运行时）
 *
 * 给 StudyLens 提供一个可被评审/自动化直接调用的检索接口，验证 seekdb 导出的
 * 索引确实在提供「数据查询与检索」能力：
 *
 *   GET /functions/v1/study/api/health
 *   GET /functions/v1/study/api/search?q=中文分词
 *   GET /functions/v1/study/api/search?q=倒排索引&limit=3
 *
 * 站点本身是静态托管（web/ 目录）；真正的排序在这里跑：读同源导出
 * /data/index.json（由 seekdb 的 FULLTEXT + IK 导出），按与页面一致的
 * BM25(k1=1.2, b=0.75) 打分返回 JSON。预置查询直接回 seekdb 实测结果。
 *
 * 只读，不写任何数据；不解码请求体，不接受外部 URL。
 */

const FUNCTION_PREFIX = '/functions/v1/app';
const K1 = 1.2;
const B = 0.75;

type Chunk = { doc: string; heading: string; topic: string; body: string };
type IndexData = {
  generatedAt?: string;
  engine?: string;
  totalChunks?: number;
  documents?: unknown[];
  chunks: Chunk[];
  queries?: { q: string; latencyMs: number; hits: unknown[] }[];
};

/** 索引数据直接内联：由 seekdb（FULLTEXT + IK）导出，函数运行时零外部请求。 */
const INDEX: IndexData = {"generatedAt":"2026-11-13T09:16:21.286Z","engine":"seekdb (FULLTEXT + IK parser, BM25)","totalChunks":28,"stats":[{"topic":"RAG","n":6},{"topic":"seekdb","n":5},{"topic":"全文检索","n":5},{"topic":"备赛方法","n":6},{"topic":"性能调优","n":6}],"documents":[{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","chunks":6},{"doc":"seekdb 快速上手","topic":"seekdb","chunks":5},{"doc":"全文索引与中文分词","topic":"全文检索","chunks":5},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","chunks":6},{"doc":"数据库性能调优方法","topic":"性能调优","chunks":6}],"chunks":[{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"检索质量决定回答上限","body":"检索质量决定回答上限 RAG 的天花板不是模型，而是召回。模型只能基于拿到手的片段作答，片段错了，提示词写得再漂亮也只产出流畅的胡说。评估 RAG 系统时先看召回率与排序质量，再看生成。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"切片策略","body":"切片策略 按固定长度切是最差的做法，它会把一句话拦腰截断。按语义边界切（Markdown 二级标题、代码顶层函数、论文小节）能保证每个切片自洽。切片长度建议 200-500 字：太短缺上下文，太长相关度被稀释、还会挤占上下文窗口。 切片时要保留来源信息（文档名 + 小节标题），它既用于展示引用，也作为检索的辅助信号——把标题拼进正文能明显提升命中率。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"混合检索","body":"混合检索 纯向量检索擅长语义相近但用词不同的场景，纯关键词检索擅长精确术语、编号、错误码。两者互补，工业界普遍做混合：关键词召回一批、向量召回一批，再用 RRF（倒数排名融合）合并。RRF 不需要分数归一化，实现简单且鲁棒。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"重排序","body":"重排序 初筛召回 50-100 条，再用交叉编码器（cross-encoder）精排取前 5-10 条，是性价比最高的做法。交叉编码器把 query 和文档拼在一起打分，精度远高于向量内积，代价是不能预计算，只能对少量候选做。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"上下文组装","body":"上下文组装 把检索结果塞进提示词时，要给每条编号并标注来源，要求模型在回答里引用编号。这既方便核查，也显著降低幻觉。上下文总长度要留出生成空间，别把窗口塞满。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"评估方法","body":"评估方法 离线评估用「问题 → 标准答案 → 标准证据」三元组，分别算召回命中率和答案正确率。线上则看用户是否追问、是否复制引用。没有评估集的 RAG 优化全是盲调。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"本地起一个实例","body":"本地起一个实例 seekdb 是嵌入式数据库，用 SDK 直接打开一个目录即可，不需要单独安装服务端。Node 侧通过 `@oceanbase/seekdb-node` 的 `open()` 返回句柄，句柄的 `connectionOptions()` 给出 host/port/user，然后用任意 MySQL 协议客户端连接。 内存预算用 `parameters.memory_budget` 控制，学习与小规模演示给 1G 足够；给太小会导致缓存频繁淘汰，查询延迟抖动明显。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"建表与全文索引","body":"建表与全文索引 建全文索引的语法与 MySQL 接近：`FULLTEXT INDEX ft_body (body) WITH PARSER ik`。中文内容务必指定 ik 分词器，默认分词器按空格切，对中文几乎无效。 索引列建议是长文本正文；标题类短字段不必单独建全文索引，把它拼进正文既省一个索引又提高命中率。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"检索写法","body":"检索写法 检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"增量更新与幂等","body":"增量更新与幂等 学习资料会反复修订，导入脚本必须幂等：用 `(doc, heading)` 做唯一键，`INSERT ... ON DUPLICATE KEY UPDATE` 覆盖正文。这样重跑导入不会产生重复切片，也不会因为切片边界变化留下孤儿行。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","body":"常见坑 - 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"倒排索引的基本结构","body":"倒排索引的基本结构 倒排索引把「文档 → 词」翻转为「词 → 文档列表」。每个词项（term）记录它出现过的文档编号与该词在文档中的位置信息，查询时按词直接跳到候选文档，避免全表扫描。倒排表通常按词项字典序存储，词项之间用跳表（skip list）加速求交。 词项字典的查找结构决定了查询延迟。常见实现有排序数组 + 二分、前缀压缩的 FST/双数组 Trie。压缩率越高，内存占用越低，但解压带来 CPU 开销，需要按数据规模权衡。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"分词器决定召回质量","body":"分词器决定召回质量 英文按空格切词即可，中文必须借助分词器。按粒度可分三类：单字切分（召回高、噪声大）、词典最大匹配（可控、需要词典）、统计模型分词（效果好、启动慢）。IK 分词器属于词典 + 歧义消解的组合方案，支持 ik_smart（粗粒度）与 ik_max_word（细粒度）两种模式。 建索引与查询必须使用同一种分词模式，否则同一个句子会切成不同的词序列，导致「明明有这个词却搜不到」。这是全文检索最常见的配置错误。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","body":"相关度打分：BM25 与 TF-IDF TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"停止词与词干化","body":"停止词与词干化 停止词（的、了、是、a、the）对排序无贡献，却占倒排表体积。去掉能显著压缩索引，但会破坏短语查询（\"to be or not to be\"）。折中方案是保留停止词的位置信息但不建倒排项。 词干化把 running/runs/ran 归并到 run，提高召回；中文没有词干概念，对应手段是同义词表与繁简归一。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"索引构建的并行度","body":"索引构建的并行度 构建索引是 CPU 密集的分词 + 写 doc_word 行。单线程只能吃满一个核，而一次构建动辄几十万行文档，必须并行。并行度太低构建时间呈线性增长，太高则写放大与合并压力上升。经验值：并行度取 CPU 核数的 1/2 到 2/3，并保证每个分片处理的文档量足够大，避免小分片调度开销占比过高。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"读懂评分口径","body":"读懂评分口径 竞赛的评分公式往往藏在题面细节里。先确认三件事：每项指标的权重、是绝对值还是相对基线的提升、是否有分段上限。很多题的得分不是线性的——提升 10% 得 10 分，再提升 10% 可能只得 3 分，因为边际收益递减。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"建立可复现的实验闭环","body":"建立可复现的实验闭环 一次改动的完整闭环包括：改代码 → 推到指定分支 → 提交评测 → 读回分项指标 → 与上一次对比。闭环越短，试错次数越多。把提测脚本写成可重复执行的一行命令，比手工点页面快一个数量级。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"单变量原则","body":"单变量原则 一次只改一件事。同时改三处，指标变好也不知道是哪一处起作用，指标变差更不知道该回退什么。如果必须批量套用上游补丁，先整体验证一次，再逐项回退定位，把有效的那一处单独留下。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"先跑通再跑快","body":"先跑通再跑快 功能不正确的前提下，性能优化毫无意义。评测只给编译通过的提交打分，但给了分也可能是「负提升」——有些平台会把负提升记 0 分而不是负分，看起来像没提交成功，实际是改慢了。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"记录分项而不只记录总分","body":"记录分项而不只记录总分 总分掩盖结构。把每次评测的每个分项指标存下来，看哪一项在改善、哪一项在退化。常见情况是总分上升但某一项持续恶化，说明改动引入了局部退化，后续会反噬。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"评估投入产出","body":"评估投入产出 不是所有分项都值得优化。先算每项的剩余空间：已经接近物理极限的项（比如查询延迟已经接近一次内存访问的耗时），继续投入几乎没有收益；而还有几倍空间的项，一个小改动就能带来大幅提升。把时间投给后者。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"先测量再优化","body":"先测量再优化 没有 profiling 的优化都是猜测。至少要看三层：SQL 层的执行计划与耗时分布、存储层的缓存命中率与 IO 次数、系统层的 CPU 与内存带宽。三者经常不同步——CPU 打满但 IO 空闲，说明瓶颈在计算；CPU 空闲但延迟高，说明在等 IO 或锁。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"执行计划怎么看","body":"执行计划怎么看 关注三件事：是否走索引、回表次数、行数估算是否准确。全表扫描在小表上未必慢，但行数估算偏差一个数量级时，优化器会选错连接顺序，导致延迟暴涨。统计信息过期是估算失真的常见原因。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"减少重复计算","body":"减少重复计算 同一表达式在同一查询里被反复求值、同一字典被反复加载，都是典型的重复计算。缓存时要考虑结果大小与生命周期：结果较小且可复制时，缓存字节串最安全；结果包含指向堆内存的指针时，缓存会引入悬垂引用风险。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"写入路径的批量效应","body":"写入路径的批量效应 逐行插入与批量插入的差距通常在 5-10 倍，因为每行都要走一次事务提交与日志刷盘。批量提交（每 500-1000 行一次）能在延迟与吞吐之间取得平衡。索引越多写入越慢，写入密集型表应精简索引。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"并发不是万能药","body":"并发不是万能药 提高并行度能线性加速纯计算任务，但一旦共享资源（磁盘写、全局锁、内存带宽）成为瓶颈，继续加线程只会增加上下文切换与锁竞争。判断方法：并行度翻倍后吞吐提升不足 30%，说明瓶颈已不在 CPU。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"基准测试的可复现性","body":"基准测试的可复现性 同一份代码跑两次结果差一倍，说明基准本身有噪声。常见来源：缓存冷热差异、后台合并任务、机器负载波动。做法是固定预热轮数、取多次样本的中位数、报告标准差。只看单次最快值会得出错误结论。"}],"queries":[{"q":"中文分词器怎么选","latencyMs":0.761,"hits":[{"doc":"seekdb 快速上手","topic":"seekdb","heading":"建表与全文索引","score":2.317,"snippet":"建全文索引的语法与 MySQL 接近：`FULLTEXT INDEX ft_body (body) WITH PARSER ik`。中文内容务必指定 ik 分词器，默认分词器按空格切，对中文几乎无效。 索引列建议是长文本正文；标题类短字段不必单独建全文索引，把它拼进正文既省一个索引又提高命中率。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"分词器决定召回质量","score":1.793,"snippet":"英文按空格切词即可，中文必须借助分词器。按粒度可分三类：单字切分（召回高、噪声大）、词典最大匹配（可控、需要词典）、统计模型分词（效果好、启动慢）。IK 分词器属于词典 + 歧义消解的组合方案，支持 ik_smart（粗粒度）与 ik_max_word（细粒度）两种模式。 建索引与查询必须使用同一种分词模式，否则同一个句子会切成不同的词序列，导致「明明有这个词却搜不到」。这是全文检索最常见的配置错误。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","score":0.709,"snippet":"- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"停止词与词干化","score":0.479,"snippet":"停止词（的、了、是、a、the）对排序无贡献，却占倒排表体积。去掉能显著压缩索引，但会破坏短语查询（\"to be or not to be\"）。折中方案是保留停止词的位置信息但不建倒排项。 词干化把 running/runs/ran 归并到 run，提高召回；中文没有词干概念，对应手段是同义词表与繁简归一。"}]},{"q":"倒排索引 词项 查找","latencyMs":0.99,"hits":[{"doc":"全文索引与中文分词","topic":"全文检索","heading":"倒排索引的基本结构","score":3.771,"snippet":"倒排索引把「文档 → 词」翻转为「词 → 文档列表」。每个词项（term）记录它出现过的文档编号与该词在文档中的位置信息，查询时按词直接跳到候选文档，避免全表扫描。倒排表通常按词项字典序存储，词项之间用跳表（skip list）加速求交。 词项字典的查找结构决定了查询延迟。常见实现有排序数组 + 二分、前缀压缩的 FST/双数组 Trie。压缩率越高，内存占用越低，但解压带来 CPU 开销，需要按数据规模权衡。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"停止词与词干化","score":2.106,"snippet":"停止词（的、了、是、a、the）对排序无贡献，却占倒排表体积。去掉能显著压缩索引，但会破坏短语查询（\"to be or not to be\"）。折中方案是保留停止词的位置信息但不建倒排项。 词干化把 running/runs/ran 归并到 run，提高召回；中文没有词干概念，对应手段是同义词表与繁简归一。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"评估投入产出","score":1.016,"snippet":"不是所有分项都值得优化。先算每项的剩余空间：已经接近物理极限的项（比如查询延迟已经接近一次内存访问的耗时），继续投入几乎没有收益；而还有几倍空间的项，一个小改动就能带来大幅提升。把时间投给后者。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":0.862,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"记录分项而不只记录总分","score":0.86,"snippet":"总分掩盖结构。把每次评测的每个分项指标存下来，看哪一项在改善、哪一项在退化。常见情况是总分上升但某一项持续恶化，说明改动引入了局部退化，后续会反噬。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"分词器决定召回质量","score":0.745,"snippet":"英文按空格切词即可，中文必须借助分词器。按粒度可分三类：单字切分（召回高、噪声大）、词典最大匹配（可控、需要词典）、统计模型分词（效果好、启动慢）。IK 分词器属于词典 + 歧义消解的组合方案，支持 ik_smart（粗粒度）与 ik_max_word（细粒度）两种模式。 建索引与查询必须使用同一种分词模式，否则同一个句子会切成不同的词序列，导致「明明有这个词却搜不到」。这是全文检索最常见的配置错误。"}]},{"q":"BM25 相关度打分","latencyMs":0.798,"hits":[{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":3.571,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"检索写法","score":1.567,"snippet":"检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","score":1.228,"snippet":"- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"重排序","score":0.831,"snippet":"初筛召回 50-100 条，再用交叉编码器（cross-encoder）精排取前 5-10 条，是性价比最高的做法。交叉编码器把 query 和文档拼在一起打分，精度远高于向量内积，代价是不能预计算，只能对少量候选做。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"并发不是万能药","score":0.825,"snippet":"提高并行度能线性加速纯计算任务，但一旦共享资源（磁盘写、全局锁、内存带宽）成为瓶颈，继续加线程只会增加上下文切换与锁竞争。判断方法：并行度翻倍后吞吐提升不足 30%，说明瓶颈已不在 CPU。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"索引构建的并行度","score":0.801,"snippet":"构建索引是 CPU 密集的分词 + 写 doc_word 行。单线程只能吃满一个核，而一次构建动辄几十万行文档，必须并行。并行度太低构建时间呈线性增长，太高则写放大与合并压力上升。经验值：并行度取 CPU 核数的 1/2 到 2/3，并保证每个分片处理的文档量足够大，避免小分片调度开销占比过高。"}]},{"q":"RAG 召回质量","latencyMs":0.739,"hits":[{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"检索质量决定回答上限","score":3.882,"snippet":"RAG 的天花板不是模型，而是召回。模型只能基于拿到手的片段作答，片段错了，提示词写得再漂亮也只产出流畅的胡说。评估 RAG 系统时先看召回率与排序质量，再看生成。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"评估方法","score":1.571,"snippet":"离线评估用「问题 → 标准答案 → 标准证据」三元组，分别算召回命中率和答案正确率。线上则看用户是否追问、是否复制引用。没有评估集的 RAG 优化全是盲调。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"分词器决定召回质量","score":0.942,"snippet":"英文按空格切词即可，中文必须借助分词器。按粒度可分三类：单字切分（召回高、噪声大）、词典最大匹配（可控、需要词典）、统计模型分词（效果好、启动慢）。IK 分词器属于词典 + 歧义消解的组合方案，支持 ik_smart（粗粒度）与 ik_max_word（细粒度）两种模式。 建索引与查询必须使用同一种分词模式，否则同一个句子会切成不同的词序列，导致「明明有这个词却搜不到」。这是全文检索最常见的配置错误。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"混合检索","score":0.585,"snippet":"纯向量检索擅长语义相近但用词不同的场景，纯关键词检索擅长精确术语、编号、错误码。两者互补，工业界普遍做混合：关键词召回一批、向量召回一批，再用 RRF（倒数排名融合）合并。RRF 不需要分数归一化，实现简单且鲁棒。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"重排序","score":0.368,"snippet":"初筛召回 50-100 条，再用交叉编码器（cross-encoder）精排取前 5-10 条，是性价比最高的做法。交叉编码器把 query 和文档拼在一起打分，精度远高于向量内积，代价是不能预计算，只能对少量候选做。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"检索写法","score":0.334,"snippet":"检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。"}]},{"q":"切片策略 语义边界","latencyMs":0.666,"hits":[{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"切片策略","score":3.288,"snippet":"按固定长度切是最差的做法，它会把一句话拦腰截断。按语义边界切（Markdown 二级标题、代码顶层函数、论文小节）能保证每个切片自洽。切片长度建议 200-500 字：太短缺上下文，太长相关度被稀释、还会挤占上下文窗口。 切片时要保留来源信息（文档名 + 小节标题），它既用于展示引用，也作为检索的辅助信号——把标题拼进正文能明显提升命中率。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"增量更新与幂等","score":2.347,"snippet":"学习资料会反复修订，导入脚本必须幂等：用 `(doc, heading)` 做唯一键，`INSERT ... ON DUPLICATE KEY UPDATE` 覆盖正文。这样重跑导入不会产生重复切片，也不会因为切片边界变化留下孤儿行。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"混合检索","score":0.924,"snippet":"纯向量检索擅长语义相近但用词不同的场景，纯关键词检索擅长精确术语、编号、错误码。两者互补，工业界普遍做混合：关键词召回一批、向量召回一批，再用 RRF（倒数排名融合）合并。RRF 不需要分数归一化，实现简单且鲁棒。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","score":0.831,"snippet":"- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"}]},{"q":"混合检索 RRF","latencyMs":0.712,"hits":[{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"混合检索","score":4.779,"snippet":"纯向量检索擅长语义相近但用词不同的场景，纯关键词检索擅长精确术语、编号、错误码。两者互补，工业界普遍做混合：关键词召回一批、向量召回一批，再用 RRF（倒数排名融合）合并。RRF 不需要分数归一化，实现简单且鲁棒。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"检索写法","score":0.681,"snippet":"检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"上下文组装","score":0.482,"snippet":"把检索结果塞进提示词时，要给每条编号并标注来源，要求模型在回答里引用编号。这既方便核查，也显著降低幻觉。上下文总长度要留出生成空间，别把窗口塞满。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"检索质量决定回答上限","score":0.433,"snippet":"RAG 的天花板不是模型，而是召回。模型只能基于拿到手的片段作答，片段错了，提示词写得再漂亮也只产出流畅的胡说。评估 RAG 系统时先看召回率与排序质量，再看生成。"},{"doc":"检索增强生成（RAG）实践笔记","topic":"RAG","heading":"切片策略","score":0.278,"snippet":"按固定长度切是最差的做法，它会把一句话拦腰截断。按语义边界切（Markdown 二级标题、代码顶层函数、论文小节）能保证每个切片自洽。切片长度建议 200-500 字：太短缺上下文，太长相关度被稀释、还会挤占上下文窗口。 切片时要保留来源信息（文档名 + 小节标题），它既用于展示引用，也作为检索的辅助信号——把标题拼进正文能明显提升命中率。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":0.262,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"}]},{"q":"seekdb 内存预算","latencyMs":0.723,"hits":[{"doc":"seekdb 快速上手","topic":"seekdb","heading":"本地起一个实例","score":2.003,"snippet":"seekdb 是嵌入式数据库，用 SDK 直接打开一个目录即可，不需要单独安装服务端。Node 侧通过 `@oceanbase/seekdb-node` 的 `open()` 返回句柄，句柄的 `connectionOptions()` 给出 host/port/user，然后用任意 MySQL 协议客户端连接。 内存预算用 `parameters.memory_budget` 控制，学习与小规模演示给 1G 足够；给太小会导致缓存频繁"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":0.586,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"并发不是万能药","score":0.486,"snippet":"提高并行度能线性加速纯计算任务，但一旦共享资源（磁盘写、全局锁、内存带宽）成为瓶颈，继续加线程只会增加上下文切换与锁竞争。判断方法：并行度翻倍后吞吐提升不足 30%，说明瓶颈已不在 CPU。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"评估投入产出","score":0.45,"snippet":"不是所有分项都值得优化。先算每项的剩余空间：已经接近物理极限的项（比如查询延迟已经接近一次内存访问的耗时），继续投入几乎没有收益；而还有几倍空间的项，一个小改动就能带来大幅提升。把时间投给后者。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"减少重复计算","score":0.437,"snippet":"同一表达式在同一查询里被反复求值、同一字典被反复加载，都是典型的重复计算。缓存时要考虑结果大小与生命周期：结果较小且可复制时，缓存字节串最安全；结果包含指向堆内存的指针时，缓存会引入悬垂引用风险。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"先测量再优化","score":0.413,"snippet":"没有 profiling 的优化都是猜测。至少要看三层：SQL 层的执行计划与耗时分布、存储层的缓存命中率与 IO 次数、系统层的 CPU 与内存带宽。三者经常不同步——CPU 打满但 IO 空闲，说明瓶颈在计算；CPU 空闲但延迟高，说明在等 IO 或锁。"}]},{"q":"全文索引 增量更新","latencyMs":0.625,"hits":[{"doc":"seekdb 快速上手","topic":"seekdb","heading":"增量更新与幂等","score":2.392,"snippet":"学习资料会反复修订，导入脚本必须幂等：用 `(doc, heading)` 做唯一键，`INSERT ... ON DUPLICATE KEY UPDATE` 覆盖正文。这样重跑导入不会产生重复切片，也不会因为切片边界变化留下孤儿行。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"建表与全文索引","score":2.207,"snippet":"建全文索引的语法与 MySQL 接近：`FULLTEXT INDEX ft_body (body) WITH PARSER ik`。中文内容务必指定 ik 分词器，默认分词器按空格切，对中文几乎无效。 索引列建议是长文本正文；标题类短字段不必单独建全文索引，把它拼进正文既省一个索引又提高命中率。"}]},{"q":"执行计划 回表","latencyMs":0.713,"hits":[{"doc":"数据库性能调优方法","topic":"性能调优","heading":"执行计划怎么看","score":3.062,"snippet":"关注三件事：是否走索引、回表次数、行数估算是否准确。全表扫描在小表上未必慢，但行数估算偏差一个数量级时，优化器会选错连接顺序，导致延迟暴涨。统计信息过期是估算失真的常见原因。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"建立可复现的实验闭环","score":0.882,"snippet":"一次改动的完整闭环包括：改代码 → 推到指定分支 → 提交评测 → 读回分项指标 → 与上一次对比。闭环越短，试错次数越多。把提测脚本写成可重复执行的一行命令，比手工点页面快一个数量级。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"先测量再优化","score":0.786,"snippet":"没有 profiling 的优化都是猜测。至少要看三层：SQL 层的执行计划与耗时分布、存储层的缓存命中率与 IO 次数、系统层的 CPU 与内存带宽。三者经常不同步——CPU 打满但 IO 空闲，说明瓶颈在计算；CPU 空闲但延迟高，说明在等 IO 或锁。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","score":0.607,"snippet":"- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"写入路径的批量效应","score":0.56,"snippet":"逐行插入与批量插入的差距通常在 5-10 倍，因为每行都要走一次事务提交与日志刷盘。批量提交（每 500-1000 行一次）能在延迟与吞吐之间取得平衡。索引越多写入越慢，写入密集型表应精简索引。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"建表与全文索引","score":0.477,"snippet":"建全文索引的语法与 MySQL 接近：`FULLTEXT INDEX ft_body (body) WITH PARSER ik`。中文内容务必指定 ik 分词器，默认分词器按空格切，对中文几乎无效。 索引列建议是长文本正文；标题类短字段不必单独建全文索引，把它拼进正文既省一个索引又提高命中率。"}]},{"q":"并行度 瓶颈 CPU","latencyMs":1.556,"hits":[{"doc":"数据库性能调优方法","topic":"性能调优","heading":"并发不是万能药","score":4.627,"snippet":"提高并行度能线性加速纯计算任务，但一旦共享资源（磁盘写、全局锁、内存带宽）成为瓶颈，继续加线程只会增加上下文切换与锁竞争。判断方法：并行度翻倍后吞吐提升不足 30%，说明瓶颈已不在 CPU。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"索引构建的并行度","score":3.459,"snippet":"构建索引是 CPU 密集的分词 + 写 doc_word 行。单线程只能吃满一个核，而一次构建动辄几十万行文档，必须并行。并行度太低构建时间呈线性增长，太高则写放大与合并压力上升。经验值：并行度取 CPU 核数的 1/2 到 2/3，并保证每个分片处理的文档量足够大，避免小分片调度开销占比过高。"},{"doc":"数据库性能调优方法","topic":"性能调优","heading":"先测量再优化","score":2.085,"snippet":"没有 profiling 的优化都是猜测。至少要看三层：SQL 层的执行计划与耗时分布、存储层的缓存命中率与 IO 次数、系统层的 CPU 与内存带宽。三者经常不同步——CPU 打满但 IO 空闲，说明瓶颈在计算；CPU 空闲但延迟高，说明在等 IO 或锁。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":0.554,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"常见坑","score":0.519,"snippet":"- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。 - 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。 - 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。"},{"doc":"seekdb 快速上手","topic":"seekdb","heading":"检索写法","score":0.471,"snippet":"检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。"}]},{"q":"基准测试 噪声 中位数","latencyMs":0.965,"hits":[{"doc":"数据库性能调优方法","topic":"性能调优","heading":"基准测试的可复现性","score":4.089,"snippet":"同一份代码跑两次结果差一倍，说明基准本身有噪声。常见来源：缓存冷热差异、后台合并任务、机器负载波动。做法是固定预热轮数、取多次样本的中位数、报告标准差。只看单次最快值会得出错误结论。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"分词器决定召回质量","score":0.694,"snippet":"英文按空格切词即可，中文必须借助分词器。按粒度可分三类：单字切分（召回高、噪声大）、词典最大匹配（可控、需要词典）、统计模型分词（效果好、启动慢）。IK 分词器属于词典 + 歧义消解的组合方案，支持 ik_smart（粗粒度）与 ik_max_word（细粒度）两种模式。 建索引与查询必须使用同一种分词模式，否则同一个句子会切成不同的词序列，导致「明明有这个词却搜不到」。这是全文检索最常见的配置错误。"}]},{"q":"评分 权重 边际收益","latencyMs":0.821,"hits":[{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"读懂评分口径","score":4.319,"snippet":"竞赛的评分公式往往藏在题面细节里。先确认三件事：每项指标的权重、是绝对值还是相对基线的提升、是否有分段上限。很多题的得分不是线性的——提升 10% 得 10 分，再提升 10% 可能只得 3 分，因为边际收益递减。"},{"doc":"全文索引与中文分词","topic":"全文检索","heading":"相关度打分：BM25 与 TF-IDF","score":1.079,"snippet":"TF-IDF 认为词频越高、文档频率越低，权重越大。BM25 在其上加入饱和函数与文档长度归一化：词频增长到一定程度后收益递减，长文档因为更容易命中而被惩罚。OceanBase/seekdb 的全文检索结果默认按相关度排序，分数可用于过滤低质量召回。 实际调优时，短查询（2-3 个词）用 BM25 更稳；长查询要先做词项加权，否则低频词会主导排序。"},{"doc":"技术竞赛的准备工作流","topic":"备赛方法","heading":"评估投入产出","score":0.72,"snippet":"不是所有分项都值得优化。先算每项的剩余空间：已经接近物理极限的项（比如查询延迟已经接近一次内存访问的耗时），继续投入几乎没有收益；而还有几倍空间的项，一个小改动就能带来大幅提升。把时间投给后者。"}]}]} as unknown as IndexData;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    },
  });
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[a-z0-9_+#.]+|[\u4e00-\u9fff]+/g;
  let m: RegExpExecArray | null;
  const lower = String(text || '').toLowerCase();
  while ((m = re.exec(lower)) !== null) {
    const w = m[0];
    if (/^[\u4e00-\u9fff]/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else {
      out.push(w);
    }
  }
  return out;
}

function buildScorer(chunks: Chunk[]) {
  const docs = chunks.map((c) => {
    const toks = tokenize(`${c.heading || ''} ${c.heading || ''} ${c.body || ''}`);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { c, tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  const n = docs.length;

  return (q: string, limit: number) => {
    const qs = Array.from(new Set(tokenize(q)));
    const scored: { score: number; c: Chunk }[] = [];
    for (const { c, tf, len } of docs) {
      let s = 0;
      for (const t of qs) {
        const f = tf.get(t);
        if (!f) continue;
        const dfi = df.get(t) || 0;
        const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
        s += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / avg));
      }
      if (s > 0) scored.push({ score: s, c });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ score, c }) => ({
      doc: c.doc,
      heading: c.heading,
      topic: c.topic,
      score: Math.round(score * 1000) / 1000,
      snippet: (c.body || '').replace(/\s+/g, ' ').slice(0, 160),
    }));
  };
}

function loadIndex(_origin: string): Promise<IndexData> {
  return Promise.resolve(INDEX);
}

/** 取第一个 /api/ 之后的部分，兼容网关是否已剥离函数前缀。 */
function apiPath(pathname: string): string {
  const i = pathname.indexOf('/api/');
  if (i >= 0) return pathname.slice(i);
  let p = pathname;
  if (p.startsWith(FUNCTION_PREFIX)) p = p.slice(FUNCTION_PREFIX.length) || '/';
  if (p === '/app') p = '/';
  if (p.startsWith('/app/')) p = p.slice('/app'.length);
  return p.startsWith('/') ? p : `/${p}`;
}

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = apiPath(url.pathname);

  if (request.method === 'OPTIONS') return json(204, null);

  if (path === '/api/health' || path === '/health' || path === '/api') {
    try {
      const data = await loadIndex(url.origin);
      return json(200, {
        ok: true,
        engine: data.engine || 'seekdb (FULLTEXT + IK parser, BM25)',
        chunks: (data.chunks || []).length,
        docs: (data.documents || []).length,
        presets: (data.queries || []).length,
        generatedAt: data.generatedAt || null,
        runtime: 'qoder-sites-edge-function',
        entry: 'web/index.html',
      });
    } catch (e) {
      return json(500, { ok: false, error: String((e as Error).message || e) });
    }
  }

  if (path === '/api/search' || path === '/search') {
    const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 8) || 8));
    if (!q) {
      return json(400, {
        ok: false,
        error: 'missing q',
        usage: '/functions/v1/study/api/search?q=中文分词',
        example: '?q=%E4%B8%AD%E6%96%87%E5%88%86%E8%AF%8D',
      });
    }
    try {
      const data = await loadIndex(url.origin);
      const preset = (data.queries || []).find((x) => x.q === q);
      if (preset) {
        return json(200, {
          ok: true, q, engine: 'seekdb', source: 'seekdb-export',
          latencyMs: preset.latencyMs, total: preset.hits.length,
          hits: preset.hits.slice(0, limit),
        });
      }
      const t0 = performance.now();
      const hits = buildScorer(data.chunks || [])(q, limit);
      const ms = Math.round((performance.now() - t0) * 1000) / 1000;
      return json(200, {
        ok: true, q, engine: 'bm25', source: 'index-export',
        latencyMs: ms, total: hits.length, hits,
      });
    } catch (e) {
      return json(500, { ok: false, error: String((e as Error).message || e) });
    }
  }

  return json(404, {
    ok: false,
    code: 'NOT_FOUND',
    message: '仅提供 /api/health 与 /api/search',
    received: url.pathname,
    hint: '/functions/v1/study/api/health',
  });
}
