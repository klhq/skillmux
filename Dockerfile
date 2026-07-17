# Stage 1: Base - Install dependencies
FROM oven/bun:1-slim AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Stage 2: Models downloader
FROM base AS models
COPY scripts/download-models.ts scripts/
RUN bun run scripts/download-models.ts

# Stage 3: Slim runtime (no models baked in)
FROM oven/bun:1-slim AS slim
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY src/ src/
ENV RUNNING_IN_DOCKER=true \
    VAULT_PATH=/vault \
    STATE_DIR=/data \
    PORT=3000
EXPOSE 3000
VOLUME ["/vault", "/data"]
ENTRYPOINT ["bun", "run", "src/cli.ts", "serve", "--transport", "http"]

# Stage 4: Full runtime (battery-included with models)
FROM slim AS full
COPY --from=models /app/.models /app/.models
ENV SKILL_ROUTER_MODELS_DIR=/app/.models
