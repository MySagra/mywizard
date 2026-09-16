#!/usr/bin/env bash
# Local test suite for the MySagra installer.
#
#   ./scripts/test-local.sh            # build + generation tests (no stack started)
#   ./scripts/test-local.sh --image    # also builds and tests the Docker image
#
# It never touches your real deployment: everything happens in a temp folder.
set -euo pipefail

cd "$(dirname "$0")/.."

WITH_IMAGE=0
[ "${1:-}" = "--image" ] && WITH_IMAGE=1

pass() { echo "  ✅ $1"; }
step() { echo; echo "▶ $1"; }

step "Typecheck, lint, format and build"
pnpm check
pnpm build
pass "checks and build ok"

step "Advanced setup with the bundled Caddy connector"
TMPC="$(mktemp -d)"
node dist/index.js --non-interactive --out "$TMPC" \
  --setup advanced --stack-name sagra-caddy --server-ip 192.168.1.100 \
  --services mycassa --connector caddy >/dev/null
grep -q "CONNECTOR=caddy" "$TMPC/.env"
grep -q "COMPOSE_PROFILES=proxy,mycassa" "$TMPC/.env"
test -s "$TMPC/Caddyfile"
grep -q "cashier-192-168-1-100.sslip.io" "$TMPC/Caddyfile"
docker compose -f "$TMPC/docker-compose.yml" --env-file "$TMPC/.env" config -q
rm -rf "$TMPC"
pass "standalone Caddy also available in the advanced setup"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step "Generation (LAN, all services, hybrid hostnames + IP)"
node dist/index.js --non-interactive \
  --out "$TMP/lan" \
  --mode lan --server-ip 192.168.1.100 \
  --services all --require-table --no-show-numbers >/dev/null
for f in .env docker-compose.yml Caddyfile CERTIFICATES.md rootCA.pem extract-rootca.sh; do
  test -s "$TMP/lan/$f" || { echo "missing $f"; exit 1; }
done
grep -q "COMPOSE_PROFILES=proxy,mycassa,myadmin,mystampa,mynumeri,myclienti,dbgate" "$TMP/lan/.env"
grep -q "REQUIRE_TABLE=true" "$TMP/lan/.env"
grep -q "BASE_DOMAIN=192-168-1-100.sslip.io" "$TMP/lan/.env"
grep -q "api-192-168-1-100.sslip.io" "$TMP/lan/Caddyfile"
grep -q "DNS_MODE=hybrid" "$TMP/lan/.env"
grep -q "default_sni 192.168.1.100" "$TMP/lan/Caddyfile"
grep -q "https://192.168.1.100:8443" "$TMP/lan/Caddyfile"
grep -q "8443:8443" "$TMP/lan/docker-compose.yml"
grep -q "MYSTAMPA_API_KEY=ms_pt_CHANGE_ME" "$TMP/lan/.env"
grep -q "MYCLIENTI_API_KEY=ms_wb_CHANGE_ME" "$TMP/lan/.env"
grep -q "SHOW_NUMBERS=false" "$TMP/lan/.env"
pass "files generated with the expected profiles/options"

step "docker compose validation"
docker compose -f "$TMP/lan/docker-compose.yml" --env-file "$TMP/lan/.env" config -q
profiles="$(docker compose -f "$TMP/lan/docker-compose.yml" --env-file "$TMP/lan/.env" config --profiles | tr '\n' ' ')"
echo "  profiles: $profiles"
# only Caddy may publish ports
published="$(docker compose -f "$TMP/lan/docker-compose.yml" --env-file "$TMP/lan/.env" config \
  | grep -c "published:" || true)"
test "$published" -le 20 || { echo "unexpected published ports: $published"; exit 1; }
pass "compose valid, only Caddy publishes ports"

step "Caddyfile validation (LAN)"
docker run --rm -v "$TMP/lan/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile 2>&1 | grep -q "Valid configuration"
pass "caddy validate ok"

step "Dynamic .env (sections follow the selected services)"
node dist/index.js --non-interactive --out "$TMP/minimal" \
  --server-ip 192.168.1.100 --services mycassa >/dev/null
! grep -q "MYSTAMPA_API_KEY" "$TMP/minimal/.env"
! grep -q "MYCLIENTI_API_KEY" "$TMP/minimal/.env"
! grep -q "DBGATE_" "$TMP/minimal/.env"
! grep -q "AUTH_URL_NUMERI" "$TMP/minimal/.env"
grep -q "AUTH_URL_CASSA" "$TMP/minimal/.env"
pass "unused services leave no leftovers in the .env"

step "API keys are preserved across runs"
sed -i 's/^MYSTAMPA_API_KEY=.*/MYSTAMPA_API_KEY=ms_pt_real/' "$TMP/lan/.env"
node dist/index.js --non-interactive --out "$TMP/lan" >/dev/null
grep -q "MYSTAMPA_API_KEY=ms_pt_real" "$TMP/lan/.env"
grep -q "MYCLIENTI_API_KEY=ms_wb_CHANGE_ME" "$TMP/lan/.env"
pass "user-provided keys survive, placeholders stay"

step "Advanced setup (no bundled proxy)"
node dist/index.js --non-interactive --out "$TMP/adv" \
  --setup advanced --stack-name sagra-test --server-ip 127.0.0.1 \
  --services mycassa,myadmin >/dev/null
test ! -f "$TMP/adv/Caddyfile"
test ! -f "$TMP/adv/rootCA.pem"
test -s "$TMP/adv/EXPOSURE.md"
grep -q "SETUP_MODE=advanced" "$TMP/adv/.env"
grep -q "STACK_NAME=sagra-test" "$TMP/adv/.env"
grep -q "COMPOSE_PROJECT_NAME=sagra-test" "$TMP/adv/.env"
grep -q "COMPOSE_PROFILES=mycassa,myadmin" "$TMP/adv/.env"
grep -q "PUBLISH_PORTS=false" "$TMP/adv/.env"
grep -q "API_URL=http://mysagra-backend:4300" "$TMP/adv/.env"
! grep -qE "^\s+- [0-9]+:[0-9]+$" "$TMP/adv/docker-compose.yml"
docker compose -f "$TMP/adv/docker-compose.yml" --env-file "$TMP/adv/.env" config -q
pass "internal-only by default, no proxy, exposure doc generated"

step "Advanced setup with published ports and Cloudflare Tunnel"
node dist/index.js --non-interactive --out "$TMP/advp" \
  --setup advanced --stack-name sagra-pub --server-ip 127.0.0.1 \
  --services mycassa --publish-ports --port-offset 100 \
  --connector cloudflare --cloudflare-token test-token-123 >/dev/null
grep -q "PUBLISH_PORTS=true" "$TMP/advp/.env"
grep -q "CLOUDFLARE_TUNNEL_TOKEN=test-token-123" "$TMP/advp/.env"
grep -q "COMPOSE_PROFILES=mycassa,cloudflared" "$TMP/advp/.env"
grep -q "4400:4300" "$TMP/advp/docker-compose.yml"
grep -q "3131:3031" "$TMP/advp/docker-compose.yml"
grep -q "cloudflare/cloudflared" "$TMP/advp/docker-compose.yml"
docker compose -f "$TMP/advp/docker-compose.yml" --env-file "$TMP/advp/.env" config -q
pass "ports published on request, tunnel connector added"

step "Advanced setup with the nginx connector"
node dist/index.js --non-interactive --out "$TMP/advn" \
  --setup advanced --stack-name sagra-ngx --server-ip 127.0.0.1 \
  --services mycassa --connector nginx >/dev/null
grep -q "CONNECTOR=nginx" "$TMP/advn/.env"
grep -q "COMPOSE_PROFILES=mycassa,nginx" "$TMP/advn/.env"
grep -q "nginx:alpine" "$TMP/advn/docker-compose.yml"
test -s "$TMP/advn/nginx.conf"
test -d "$TMP/advn/certs"
grep -q "proxy_buffering off" "$TMP/advn/nginx.conf"
# a hand-edited nginx.conf must never be overwritten
echo "# custom" >> "$TMP/advn/nginx.conf"
node dist/index.js --non-interactive --out "$TMP/advn" >/dev/null
grep -q "# custom" "$TMP/advn/nginx.conf"
docker compose -f "$TMP/advn/docker-compose.yml" --env-file "$TMP/advn/.env" config -q
pass "nginx container added, config left to the dev"

step "Advanced setup generates a stack name when blank"
node dist/index.js --non-interactive --out "$TMP/adv2" --setup advanced --server-ip 127.0.0.1 \
  --services mycassa >/dev/null
grep -qE "STACK_NAME=mysagra-[0-9a-f]{6}" "$TMP/adv2/.env"
pass "random stack id assigned"

step "Manual DNS mode"
node dist/index.js --non-interactive --out "$TMP/manual" \
  --mode lan --server-ip 192.168.1.100 --dns manual --base-domain mysagra.lan \
  --services mycassa >/dev/null
grep -q "BASE_DOMAIN=mysagra.lan" "$TMP/manual/.env"
grep -q "192.168.1.100\s*cashier-mysagra.lan" "$TMP/manual/CERTIFICATES.md"
pass "custom domain + hosts entries documented"

step "Instance prefix"
node dist/index.js --non-interactive --out "$TMP/prefixed" \
  --server-ip 192.168.1.100 --host-prefix sagra1 --services mycassa >/dev/null
grep -q "HOST_PREFIX=sagra1" "$TMP/prefixed/.env"
grep -q "COMPOSE_PROJECT_NAME=mysagra-sagra1" "$TMP/prefixed/.env"
grep -q "cashier-sagra1-192-168-1-100.sslip.io" "$TMP/prefixed/Caddyfile"
pass "hostnames and compose project are namespaced"

step "Idempotency (secrets are reused)"
before="$(grep '^JWT_SECRET=' "$TMP/lan/.env")"
node dist/index.js --non-interactive --out "$TMP/lan" --services mycassa,myadmin >/dev/null
after="$(grep '^JWT_SECRET=' "$TMP/lan/.env")"
test "$before" = "$after"
test -f "$TMP/lan/.env.bak"
grep -q "COMPOSE_PROFILES=proxy,mycassa,myadmin$" "$TMP/lan/.env"
pass "secrets preserved, profiles updated, backup created"

step "Regeneration (--regenerate-secrets)"
node dist/index.js --non-interactive --out "$TMP/lan" --regenerate-secrets >/dev/null
test "$(grep '^JWT_SECRET=' "$TMP/lan/.env")" != "$before"
pass "secrets regenerated on demand"

step "Public mode via config file"
node dist/index.js --non-interactive --config examples/answers.public.json \
  --out "$TMP/public" --no-start >/dev/null
grep -q "TLS_MODE=caddy-acme" "$TMP/public/.env"
grep -q "email admin@mysagra.it" "$TMP/public/Caddyfile"
grep -q "Strict-Transport-Security" "$TMP/public/Caddyfile"
test ! -f "$TMP/public/rootCA.pem"
docker run --rm -v "$TMP/public/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile 2>&1 | grep -q "Valid configuration"
pass "ACME mode ok"

step "Validation errors"
if node dist/index.js --non-interactive --out "$TMP/bad" --mode public \
     --server-ip 1.2.3.4 --base-domain example.com --tls caddy-acme >/dev/null 2>&1; then
  echo "expected failure for missing ACME email"; exit 1
fi
pass "missing ACME email is rejected"

if [ "$WITH_IMAGE" = "1" ]; then
  step "Docker image build + run"
  docker build -q -t mywizard:test . >/dev/null
  mkdir -p "$TMP/img"
  docker run --rm -v "$TMP/img":/out -u "$(id -u):$(id -g)" -e HOME=/tmp \
    mywizard:test --non-interactive \
    --server-ip 192.168.1.100 --base-domain mysagra.local --services all >/dev/null
  docker compose -f "$TMP/img/docker-compose.yml" --env-file "$TMP/img/.env" config -q
  pass "image works and produces a valid stack"
fi

echo
echo "All tests passed 🎉"
