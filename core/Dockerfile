FROM node:20-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm config set registry https://registry.npmmirror.com/
RUN pnpm install --frozen-lockfile

COPY core ./core
COPY web ./web

RUN pnpm build:web
RUN pnpm -C core build:ts

# ==========================================
FROM node:20-alpine AS prod-deps

WORKDIR /app

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm config set registry https://registry.npmmirror.com/
RUN pnpm -C core install --prod --frozen-lockfile

# ==========================================

FROM node:20-alpine AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV ALLOW_ORIGIN=https://farm.linxiaoran.com


RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY --from=prod-deps /app/node_modules ../node_modules/
COPY --from=prod-deps /app/core/node_modules ./node_modules/
COPY --from=prod-deps /app/package.json ../package.json
COPY --from=prod-deps /app/core/package.json ./package.json

COPY --from=builder /app/core/client.js ./client.js
COPY --from=builder /app/core/dist ./dist
COPY --from=builder /app/core/src/gameConfig ./src/gameConfig
COPY --from=builder /app/core/src/proto ./src/proto
RUN mkdir -p src/utils data/logs
COPY --from=builder /app/core/src/utils/tsdk.wasm ./src/utils/tsdk.wasm
COPY --from=builder /app/web/dist ../web/dist

RUN chmod -R 755 data

VOLUME ["/app/core/data"]

EXPOSE 3690

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3690/api/game-version || exit 1

CMD ["node", "client.js"]
