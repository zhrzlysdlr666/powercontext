# 运行说明

本赛题的提交物在 [qoder/](./qoder/) 目录，入口文档：

- 运行说明：[qoder/RUN.md](./qoder/RUN.md) · [qoder/README.md](./qoder/README.md)
- 验证样例：[qoder/VERIFY.md](./qoder/VERIFY.md)
- Qoder 开发记录：[qoder/DEVLOG.md](./qoder/DEVLOG.md)
- 项目说明：[qoder/SKILL.md](./qoder/SKILL.md)

作品页：https://studylens-lqny1ayu3yc.qoder.zone

## 跑起来

检索跑在 **seekdb** 上（嵌入式引擎，不需要 Docker、不需要数据库服务），推荐 Python 3.12：

```bash
pip install -r requirements.txt   # 只有 seekdb 客户端：pylibseekdb + pymysql
python main.py                    # 自检：建库 + 灌 84 切片 + 6 条 MATCH 查询
python main.py --serve            # http://127.0.0.1:8899/
```

`./start.sh` 是同一件事的一键版（自动挑已装好 seekdb 客户端的解释器，缺依赖时先装再起服务）；
只有一个 Node 环境时 `node main.mjs` 会转调同一份 Python 实现。

预期自检输出末尾：`SELFCHECK PASS`，退出码 0。
