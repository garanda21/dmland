# DMLand has no npm dependencies: the image only needs Node and the source.
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_FILE=/data/app.db \
    ENV_FILE=/config/.env

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Data (SQLite) and config (.env with the encryption key) live in separate volumes,
# so a database backup never contains the key.
RUN mkdir -p /data /config && chown node:node /data /config
USER node

EXPOSE 3000
# Any HTTP answer (the dashboard replies 401 without credentials) means the server is up.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(()=>process.exit(0),()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
