FROM node:22-bookworm-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 git ca-certificates \
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

FROM node:22-bookworm-slim AS production-dependencies

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS archive-tools

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/install-7zip.sh /tmp/install-7zip.sh
RUN sh /tmp/install-7zip.sh /opt/7zip

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/std4453/aoi"

COPY --from=archive-tools /opt/7zip/7z /usr/local/bin/7z
COPY --from=archive-tools /opt/7zip/7zip-LICENSE.txt /usr/local/share/licenses/7zip-LICENSE.txt

WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /src/server/dist ./dist
COPY --from=build /src/server/public ./public
COPY server/package.json ./
COPY server/healthcheck.cjs ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV DATA_DIR=/app/data
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "healthcheck.cjs"]

CMD ["node", "--enable-source-maps", "dist/server/src/index.js"]
