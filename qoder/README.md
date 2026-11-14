# StudyLens（qoder/）

- 运行说明：[RUN.md](./RUN.md)
- 验证样例：[VERIFY.md](./VERIFY.md)
- 开发记录：[DEVLOG.md](./DEVLOG.md)
- 项目说明：[SKILL.md](./SKILL.md)

核心一句话：资料切片进 seekdb；`FULLTEXT(ik)` 建索引；`MATCH ... AGAINST` 检索；Qoder Sites 发布。

```bash
pip install -r requirements.txt
python main.py            # SELFCHECK PASS
python main.py --serve    # http://127.0.0.1:8899/
```
