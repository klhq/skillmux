# Stage 1: Base - dependencies for the model prefetch
FROM oven/bun:1-slim AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Stage 2: Compile the Linux executable for the target architecture.
# Pinned to BUILDPLATFORM and cross-compiled: bun build --compile targets any
# platform from any host, so a linux/arm64 image never QEMU-emulates the
# compile itself. onnxruntime-node ships every platform's libraries in one
# tarball, so the target's shared library is available here regardless of which
# architecture this stage runs on.
FROM --platform=$BUILDPLATFORM oven/bun:1-slim AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY scripts/ scripts/
RUN set -eux; \
    case "$TARGETARCH" in \
      arm64) ARCH=arm64 ;; \
      amd64) ARCH=x64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    SKILLMUX_BINARY_TARGET="linux-$ARCH" SKILLMUX_BINARY_OUT_DIR=/out \
      bun run scripts/build-binaries.ts; \
    mv "/out/skillmux-linux-$ARCH" /out/skillmux; \
    cp "node_modules/onnxruntime-node/bin/napi-v6/linux/$ARCH/libonnxruntime.so.1" /out/

# Stage 3: Default local model bundle
# Copies only the closed import set the prefetch needs (download-models.ts ->
# config.ts -> agent-ids.ts and types.ts, plus models.ts) rather than all of
# src/; tests/dockerfile.test.ts checks the set stays closed. Copying the
# whole tree invalidates this layer — and re-downloads the 34MB bundle from
# HuggingFace — on every unrelated source change, which is what made CI flaky.
FROM base AS models
COPY scripts/download-models.ts scripts/
COPY src/agent-ids.ts src/config.ts src/models.ts src/types.ts src/
ENV SKILLMUX_MODELS_DIR=/models
RUN bun run scripts/download-models.ts

# Stage 4: Slim runtime (no models, no ONNX runtime library)
# curl is the readiness probe: the image carries no JavaScript runtime to
# script one with.
FROM debian:trixie-slim AS slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/skillmux /usr/local/bin/skillmux
ENV RUNNING_IN_DOCKER=true \
    SKILLMUX_IMAGE_VARIANT=slim \
    VAULT_PATH=/vault \
    STATE_DIR=/data \
    PORT=3000
EXPOSE 3000
VOLUME ["/vault", "/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/health/ready || exit 1
ENTRYPOINT ["/usr/local/bin/skillmux"]
CMD ["serve", "--transport", "http"]

# Stage 5: Full runtime (battery-included with models and local inference)
# The executable embeds onnxruntime's addon but not the library it links
# against, so the full variant ships that library and points the loader at it.
FROM slim AS full
COPY --from=models /models /models
COPY --from=build /out/libonnxruntime.so.1 /opt/skillmux/lib/
ENV SKILLMUX_IMAGE_VARIANT=full \
    SKILLMUX_MODELS_DIR=/models \
    LD_LIBRARY_PATH=/opt/skillmux/lib

# Stage 6: Model export — filesystem-only target, not a runnable image.
# CI builds this with the buildx GHA layer cache and exports it to disk, so the
# test job gets the model bundle without touching the network mid-test.
FROM scratch AS models-export
COPY --from=models /models /models
