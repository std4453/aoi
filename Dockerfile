FROM node:22-slim

# Install unrar for RAR extraction and build tools for sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    unrar \
    p7zip-full \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./

# Copy built client
COPY server/public ./public/

# Create data directory
RUN mkdir -p /app/data

EXPOSE 3000
ENV DATA_DIR=/app/data
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", "--enable-source-maps", "dist/index.js"]
