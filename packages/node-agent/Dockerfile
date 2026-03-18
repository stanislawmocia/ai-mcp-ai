FROM node:22-alpine AS builder
WORKDIR /app
COPY packages/node-agent/package.json packages/node-agent/package-lock.json* ./
RUN npm install
COPY packages/node-agent/tsconfig.json ./
COPY packages/node-agent/src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY packages/node-agent/entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

EXPOSE 7432
ENTRYPOINT ["./entrypoint.sh"]
