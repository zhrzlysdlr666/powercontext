# StudyLens · 一条命令起服务（检索跑在嵌入式 seekdb 上，不需要外部数据库）
#   docker build -t studylens . && docker run --rm -p 3000:3000 studylens
#   docker compose up
FROM python:3.12-slim

WORKDIR /app

# seekdb 嵌入式引擎 + MySQL 协议驱动（服务端模式用）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=3000 \
    HOST=0.0.0.0 \
    SEEKDB_DIR=/app/data/seekdb \
    PYTHONUNBUFFERED=1

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=4).status==200 else 1)"

CMD ["python", "main.py", "--serve"]
