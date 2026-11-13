# 仓库根 Dockerfile：一条命令起 StudyLens（Qoder 赛题作品）
#   docker build -t studylens . && docker run --rm -p 3000:3000 studylens
#   docker compose up
FROM node:22-alpine
WORKDIR /app
COPY qoder ./qoder
WORKDIR /app/qoder
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "main.mjs", "--serve"]
