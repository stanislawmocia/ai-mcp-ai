FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY packages/node-agent/package.json ./
RUN bun install
COPY packages/node-agent/tsconfig.json ./
COPY packages/node-agent/src ./src
RUN bun build src/bin/cli.ts --outdir ./dist/bin --target bun && \
    bun build src/server.ts --outdir ./dist --target bun

FROM oven/bun:1-alpine
RUN apk add --no-cache git curl
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY packages/node-agent/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 7432
ENTRYPOINT ["./entrypoint.sh"]
