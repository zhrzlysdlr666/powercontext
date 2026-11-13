# StudyLens · one-command run (no build deps, no database server needed)
#   docker build -t studylens . && docker run --rm -p 3000:3000 studylens
#   docker compose up
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY main.mjs ./
COPY src ./src
COPY web ./web
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "main.mjs", "--serve"]
