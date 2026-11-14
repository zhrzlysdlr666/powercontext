# 仓库根 Dockerfile：一条命令起 StudyLens（Qoder 赛题作品）
#   docker build -t studylens . && docker run --rm -p 3000:3000 studylens
#   docker compose up
#
# 检索与存储跑在嵌入式 seekdb（pylibseekdb）上，容器内不需要另起数据库服务。
FROM python:3.12-slim

WORKDIR /app/qoder

COPY qoder/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY qoder ./ 

ENV PORT=3000 \
    HOST=0.0.0.0 \
    SEEKDB_DIR=/app/qoder/data/seekdb \
    PYTHONUNBUFFERED=1

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=4).status==200 else 1)"

CMD ["python", "main.py", "--serve"]
