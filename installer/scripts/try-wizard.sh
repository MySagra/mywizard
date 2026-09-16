#!/usr/bin/env bash
# Try the interactive wizard locally, in a throwaway folder.
#
#   ./scripts/try-wizard.sh              # run from sources (pnpm build + node)
#   ./scripts/try-wizard.sh --image      # run the Docker image instead
#   ./scripts/try-wizard.sh --dir ~/foo  # choose the output folder
#
# Nothing is started: the wizard only writes the configuration files, then the
# script prints them so you can inspect the result.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="source"
OUT="${TMPDIR:-/tmp}/mysagra-wizard-$(date +%s)"

while [ $# -gt 0 ]; do
  case "$1" in
    --image) MODE="image"; shift ;;
    --dir) OUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT"
echo "Output folder: $OUT"
echo

if [ "$MODE" = "image" ]; then
  docker build -t mywizard:dev .
  SOCK_ARGS=()
  [ -S /var/run/docker.sock ] && SOCK_ARGS=(-v /var/run/docker.sock:/var/run/docker.sock)
  docker run --rm -it \
    -v "$OUT":/out \
    "${SOCK_ARGS[@]}" \
    -u "$(id -u):$(id -g)" -e HOME=/tmp \
    mywizard:dev
else
  pnpm build
  node dist/index.js --out "$OUT"
fi

echo
echo "── Generated files ───────────────────────────────────────────"
ls -a "$OUT"
echo
echo "── .env (secrets masked) ─────────────────────────────────────"
sed -E 's/^(JWT_SECRET|PEPPER|ROOT_PASSWORD|DB_USER_PASSWORD|REDIS_PASS|DBGATE_PASSWORD)=.*/\1=***/' "$OUT/.env"
echo
echo "── Compose profiles ──────────────────────────────────────────"
docker compose -f "$OUT/docker-compose.yml" --env-file "$OUT/.env" config --profiles
echo
echo "To start the stack:   cd $OUT && docker compose up -d"
echo "To remove the test:   rm -rf $OUT"
