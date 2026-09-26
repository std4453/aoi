FROM node:22-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm ci \
    && npm ci --prefix server \
    && npm ci --prefix client

COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-slim AS production-dependencies

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /src/server/dist ./dist
COPY --from=build /src/server/public ./public
COPY server/package.json ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV DATA_DIR=/app/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "dist/server/src/index.js"]
