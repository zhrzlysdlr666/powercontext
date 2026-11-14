# 验证样例

完整版本见 [qoder/VERIFY.md](./qoder/VERIFY.md)。最短路径：

```bash
pip install -r requirements.txt      # 只有 seekdb 客户端
python main.py                       # 建库 + 灌 84 切片 + 6 条 MATCH 查询 → SELFCHECK PASS
python main.py --serve &             # http://127.0.0.1:8899/
curl -s "http://127.0.0.1:8899/api/search?q=%E5%80%92%E6%8E%92%E7%B4%A2%E5%BC%95"
python verify.py                     # 17 项一次性核对 → VERIFY PASS
```

预期要点：

| 检查 | 预期 |
|---|---|
| `python main.py` | 末尾 `SELFCHECK PASS`，退出码 0，输出里有 `seekdb 连接 — embedded / ...seekdb-v1.4.0.0` |
| `/api/health` | `{"engine":"seekdb","parser":"ik","docs":13,"chunks":84,...}` |
| `/api/search?q=倒排索引` | `total=8`，首条 `倒排索引的基本结构`，耗时个位数毫秒 |
| `python verify.py` | 17 项全 PASS，`VERIFY PASS` |

线上站点：https://studylens-lqny1ayu3yc.qoder.zone （public，无需登录，支持 `?q=` 深链）
