FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY packages/hub-core/package.json packages/hub-core/package-lock.json* ./
RUN npm install
COPY packages/hub-core/tsconfig.json ./
COPY packages/hub-core/src ./src
RUN npx tsc

FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN mkdir -p /data
EXPOSE 7433
CMD ["node", "dist/server.js"]
