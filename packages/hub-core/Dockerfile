FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY packages/hub-core/package.json ./
RUN bun install
COPY packages/hub-core/tsconfig.json ./
COPY packages/hub-core/src ./src
RUN bun build src/server.ts --outdir ./dist --target bun

FROM oven/bun:1-alpine
RUN apk add --no-cache wget
RUN addgroup -g 1001 meshmind && adduser -u 1001 -G meshmind -s /bin/sh -D meshmind
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN mkdir -p /data && chown -R meshmind:meshmind /data /app
USER meshmind
EXPOSE 7433
CMD ["bun", "run", "dist/server.js"]
