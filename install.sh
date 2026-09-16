#!/usr/bin/env bash
# MySagra — stack configurator.
# Pulls and runs the installer image once (ephemeral container).
#
#   ./install.sh                      # interactive wizard
#   ./install.sh --non-interactive --mode lan --server-ip 192.168.1.10 \
#       --base-domain mysagra.local --services all
set -euo pipefail

IMAGE="${MYWIZARD_IMAGE:-ghcr.io/mysagra/mywizard:latest}"
TARGET_DIR="${MYSAGRA_DIR:-$PWD}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found: install it from https://docs.docker.com/get-docker/" >&2
  exit 1
fi

DOCKER_SOCK="/var/run/docker.sock"
SOCK_ARGS=()
if [ -S "$DOCKER_SOCK" ]; then
  SOCK_ARGS=(-v "$DOCKER_SOCK:$DOCKER_SOCK")
else
  echo "Warning: Docker socket unavailable, the installer will not be able to start the stack." >&2
fi

TTY_ARGS=()
if [ -t 0 ] && [ -t 1 ]; then
  TTY_ARGS=(-it)
fi

mkdir -p "$TARGET_DIR"

docker pull "$IMAGE"
exec docker run --rm "${TTY_ARGS[@]}" \
  -v "$TARGET_DIR:/out" \
  "${SOCK_ARGS[@]}" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "$IMAGE" "$@"
