# seekdb 快速上手

## 本地起一个实例

seekdb 是嵌入式数据库，用 SDK 直接打开一个目录即可，不需要单独安装服务端。Node 侧通过 `@oceanbase/seekdb-node` 的 `open()` 返回句柄，句柄的 `connectionOptions()` 给出 host/port/user，然后用任意 MySQL 协议客户端连接。

内存预算用 `parameters.memory_budget` 控制，学习与小规模演示给 1G 足够；给太小会导致缓存频繁淘汰，查询延迟抖动明显。

## 建表与全文索引

建全文索引的语法与 MySQL 接近：`FULLTEXT INDEX ft_body (body) WITH PARSER ik`。中文内容务必指定 ik 分词器，默认分词器按空格切，对中文几乎无效。

索引列建议是长文本正文；标题类短字段不必单独建全文索引，把它拼进正文既省一个索引又提高命中率。

## 检索写法

检索用 `MATCH(col) AGAINST('关键词' IN NATURAL LANGUAGE MODE)`，返回的 score 就是相关度分数。按分数倒序 + LIMIT 即可拿到最相关的片段。加 `WITH QUERY EXPANSION` 会做一次自动扩展查询，召回变高但精度下降，学习场景一般不开启。

## 增量更新与幂等

学习资料会反复修订，导入脚本必须幂等：用 `(doc, heading)` 做唯一键，`INSERT ... ON DUPLICATE KEY UPDATE` 覆盖正文。这样重跑导入不会产生重复切片，也不会因为切片边界变化留下孤儿行。

## 常见坑

- 分词模式不一致：建索引用 ik_max_word、查询用 ik_smart，会出现搜不到。
- 表字符集不是 utf8mb4：中文被截断成问号，索引里全是垃圾词。
- 切块过长：一个切片超过几千字，相关度分数被长度归一化稀释，排序失真。
