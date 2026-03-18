FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY packages/hub-mcp/package.json ./
RUN bun install
COPY packages/hub-mcp/tsconfig.json ./
COPY packages/hub-mcp/src ./src
RUN bun build src/index.ts --outdir ./dist --target bun

FROM oven/bun:1-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE 7434
CMD ["bun", "run", "dist/index.js"]
