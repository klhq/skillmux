# Stage 1: Base - Install dependencies
FROM oven/bun:1-slim AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Stage 2: Default local model bundle
# Copies only the closed import set the prefetch needs (download-models.ts ->
# config.ts -> types.ts, plus models.ts) rather than all of src/. Copying the
# whole tree invalidates this layer — and re-downloads the 34MB bundle from
# HuggingFace — on every unrelated source change, which is what made CI flaky.
FROM base AS models
COPY scripts/download-models.ts scripts/
COPY src/config.ts src/models.ts src/types.ts src/
ENV SKILLMUX_MODELS_DIR=/models
RUN bun run scripts/download-models.ts

# Stage 3: Slim runtime (no models baked in)
FROM oven/bun:1-slim AS slim
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./
COPY src/ src/
ENV RUNNING_IN_DOCKER=true \
    SKILLMUX_IMAGE_VARIANT=slim \
    VAULT_PATH=/vault \
    STATE_DIR=/data \
    PORT=3000
EXPOSE 3000
VOLUME ["/vault", "/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/health/ready");process.exit(r.ok?0:1)'
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve", "--transport", "http"]

# Stage 4: Full runtime (battery-included with models)
FROM slim AS full
COPY --from=models /models /models
ENV SKILLMUX_IMAGE_VARIANT=full \
    SKILLMUX_MODELS_DIR=/models

# Stage 5: Model export — filesystem-only target, not a runnable image.
# CI builds this with the buildx GHA layer cache and exports it to disk, so the
# test job gets the model bundle without touching the network mid-test.
FROM scratch AS models-export
COPY --from=models /models /models
