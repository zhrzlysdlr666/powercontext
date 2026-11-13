import { seekdb } from "@oceanbase/seekdb-node";
import mysql from "mysql2/promise";
const db = await seekdb.open("./data/probe", { parameters: { memory_budget: "1G" } });
const ep = db.connectionOptions();
console.log('endpoint', JSON.stringify(ep));
const conn = await mysql.createConnection({ host: ep.host, port: ep.port, user: ep.user, password: "", database: 'test' });
await conn.query("DROP TABLE IF EXISTS ft_probe");
try {
  await conn.query("CREATE TABLE ft_probe (id INT PRIMARY KEY AUTO_INCREMENT, kind VARCHAR(16), title VARCHAR(200), body TEXT, FULLTEXT INDEX ft_idx(body) WITH PARSER ik)");
  console.log('create ok with ik');
} catch (e) {
  console.log('ik failed:', e.message);
  await conn.query("CREATE TABLE ft_probe (id INT PRIMARY KEY AUTO_INCREMENT, kind VARCHAR(16), title VARCHAR(200), body TEXT, FULLTEXT INDEX ft_idx(body))");
  console.log('create ok default parser');
}
await conn.query("INSERT INTO ft_probe (kind,title,body) VALUES ('spec','分页规格','工单列表分页时页码从 1 开始，每页最多 100 条，超出范围返回空列表'),('spec','筛选规格','支持按状态、优先级和标签筛选工单'),('code','list_tickets','def list_tickets(items, status=None): return items')");
const [r1] = await conn.query("SELECT id,title, MATCH(body) AGAINST('分页 页码' IN NATURAL LANGUAGE MODE) AS score FROM ft_probe WHERE MATCH(body) AGAINST('分页 页码' IN NATURAL LANGUAGE MODE) ORDER BY score DESC");
console.log('ft rows', JSON.stringify(r1));
await conn.end(); db.close();
