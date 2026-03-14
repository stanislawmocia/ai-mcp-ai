# ── Stage 1: build TypeScript ──────────────────────────────────────────────
FROM node:22-alpine AS builder

# need python/make/g++ for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# build tools needed to recompile native modules for this exact node version
RUN apk add --no-cache python3 make g++ curl

# install tailscale CLI — detect architecture automatically (amd64 / arm64)
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  TS_ARCH="amd64" ;; \
      aarch64) TS_ARCH="arm64" ;; \
      armv7l)  TS_ARCH="arm"   ;; \
      *)       TS_ARCH="amd64" ;; \
    esac && \
    curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_latest_${TS_ARCH}.tgz" \
      | tar xzf - --strip-components=1 -C /usr/local/bin tailscale

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# copy compiled JS
COPY --from=builder /app/dist ./dist
COPY config.example.json ./config.example.json

# data directory for SQLite db
RUN mkdir -p /data

ENV NODE_ENV=production
ENV MCP_COMM_DB_PATH=/data/comm.db

EXPOSE 7432

CMD ["node", "dist/index.js"]
