FROM node:22-alpine AS builder
WORKDIR /app
COPY packages/hub-mcp/package.json packages/hub-mcp/package-lock.json* ./
RUN npm install
COPY packages/hub-mcp/tsconfig.json ./
COPY packages/hub-mcp/src ./src
RUN npx tsc

FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

EXPOSE 7434
CMD ["node", "dist/index.js"]
