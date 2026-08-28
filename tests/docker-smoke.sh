#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-skillmux:docker-smoke}"
EXPECTED_VARIANT="${2:-slim}"
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

# Doctor identifies the image variant and the retrieval lane it can actually
# use. Slim stays healthy without a bundled model; full verifies GTE-small.
docker run --rm \
  -v "$VAULT:/vault:ro" \
  -v "$DATA:/data" \
  "$IMAGE" doctor --json >"$WORKDIR/doctor.json"
EXPECTED_CAPABILITY="lexical"
if [ "$EXPECTED_VARIANT" = "full" ]; then
  EXPECTED_CAPABILITY="hybrid"
fi
jq -e \
  --arg variant "$EXPECTED_VARIANT" \
  --arg capability "$EXPECTED_CAPABILITY" \
  '.ok == true and .data.image_variant == $variant and .data.retrieval_capability == $capability' \
  "$WORKDIR/doctor.json" >/dev/null

# Help and host-management rejection must describe the server image rather than
# accidentally advertising the host CLI command surface.
docker run --rm "$IMAGE" --help >"$WORKDIR/help.out"
grep -Fq "Skillmux server image" "$WORKDIR/help.out"
grep -Fq "serve, index, doctor, report, audit prune, eval promote, scan, skill which" "$WORKDIR/help.out"
grep -Fq "config show|get|validate|diff|status" "$WORKDIR/help.out"
if grep -Fq "project, target, core" "$WORKDIR/help.out"; then
  echo "Docker help advertised host-management commands" >&2
  exit 1
fi

# Host-management operations must identify the host alternative in both text
# and JSON, including the subcommand that was rejected.
if docker run --rm "$IMAGE" init >"$WORKDIR/init.out" 2>&1; then
  echo "expected Docker init to be rejected" >&2
  exit 1
fi
grep -Fq '`skillmux init` manages host agent directories' "$WORKDIR/init.out"
grep -Fq "Then run:" "$WORKDIR/init.out"
grep -Fq "  skillmux init" "$WORKDIR/init.out"
docker run --rm "$IMAGE" models download --json >"$WORKDIR/rejected.json" || status=$?
if [ "${status:-0}" -ne 2 ]; then
  echo "expected Docker models download to exit 2" >&2
  exit 1
fi
jq -e '
  .ok == false and
  .error.code == "CONTAINER_COMMAND_UNSUPPORTED" and
  .error.details.rejected_command == "models download" and
  .error.details.recommended_host_command == "skillmux models download" and
  .error.details.documentation != null
' "$WORKDIR/rejected.json" >/dev/null

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
curl --fail --silent "http://127.0.0.1:$PORT/health/ready" | jq -e \
  --arg variant "$EXPECTED_VARIANT" \
  '.runtime == "docker" and .image_variant == $variant' >/dev/null
curl --fail --silent "http://127.0.0.1:$PORT/metrics" | grep -F \
  "skill_router_deployment_info{" | grep -F \
  "runtime=\"docker\",image_variant=\"$EXPECTED_VARIANT\"" >/dev/null

# SIGTERM is the normal container stop signal and must exit cleanly.
docker kill --signal=TERM "$CONTAINER" >/dev/null
test "$(docker wait "$CONTAINER")" = "0"
