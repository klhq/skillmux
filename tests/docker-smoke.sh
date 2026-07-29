#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-skillmux:docker-smoke}"
CONTAINER="skillmux-docker-smoke-$$"
WORKDIR="$(mktemp -d)"
VAULT="$WORKDIR/vault"
DATA="$WORKDIR/data"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$VAULT/example" "$DATA"
cat > "$VAULT/example/SKILL.md" <<'EOF'
---
name: example
description: Docker smoke-test skill.
---

# Example
EOF

# Arguments after the image replace CMD while retaining ENTRYPOINT.
docker run --rm "$IMAGE" config show >/dev/null
docker run --rm "$IMAGE" config validate >/dev/null

# Host-management operations must be rejected inside the image.
if docker run --rm "$IMAGE" init >"$WORKDIR/init.out" 2>&1; then
  echo "expected Docker init to be rejected" >&2
  exit 1
fi
grep -Fq "not supported inside the Docker image" "$WORKDIR/init.out"

# stdio is an explicit override. EOF is sufficient to prove startup and clean
# shutdown without an HTTP listener.
docker run --rm --no-healthcheck -i \
  -v "$VAULT:/vault:ro" \
  -v "$DATA:/data" \
  "$IMAGE" serve --transport stdio </dev/null

# The default command starts HTTP and becomes ready without a config directory.
docker run -d --name "$CONTAINER" -p 127.0.0.1::3000 \
  -v "$VAULT:/vault:ro" \
  -v "$DATA:/data" \
  "$IMAGE" >/dev/null
PORT="$(docker port "$CONTAINER" 3000/tcp | sed 's/.*://')"
for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$PORT/health/ready" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:$PORT/health/ready" >/dev/null

# SIGTERM is the normal container stop signal and must exit cleanly.
docker kill --signal=TERM "$CONTAINER" >/dev/null
test "$(docker wait "$CONTAINER")" = "0"
