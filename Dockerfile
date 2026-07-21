# Stage 1: Base - Install dependencies
FROM oven/bun:1-slim AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Stage 2: Default local model bundle
FROM base AS models
COPY scripts/download-models.ts scripts/
COPY src/ src/
ENV SKILLMUX_MODELS_DIR=/models
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");process.exit(r.ok?0:1)'
ENTRYPOINT ["bun", "run", "src/cli.ts", "serve", "--transport", "http"]

# Stage 4: Full runtime (battery-included with models)
FROM slim AS full
COPY --from=models /models /models
ENV SKILLMUX_MODELS_DIR=/models
