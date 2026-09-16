# MyWizard — MySagra installer

**Ephemeral** Docker image (`ghcr.io/mysagra/mywizard`) (`--rm`) that configures a MySagra stack: it asks a few questions through
a CLI wizard and generates, in the current folder, `docker-compose.yml` (with **profiles**), `.env`
(with **locally generated secrets**), `Caddyfile` (reverse proxy with automatic TLS and **SSE**
tuning) and the certificate documentation. It can optionally start the stack.

## Two setups

|                            | **Simple** (default, recommended)            | **Advanced**                                                                                                          |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Reverse proxy              | bundled **Caddy** with automatic TLS         | none: you plug the stack into your own proxy                                                                          |
| Hostnames                  | `cashier-<domain>` + direct `https://<ip>`   | `http://<host>:<port>` or `<service>-<your domain>`                                                                   |
| Published ports            | only Caddy (80/443 + IP ports)               | **none by default** (internal network); optional host ports on request                                                |
| Several stacks per machine | no (ports 80/443 are unique)                 | **yes**: stack name + port offset keep everything separate                                                            |
| Questions asked            | the bare minimum                             | stack name, public host, port publishing, trust proxy level, services, NODE_ENV, DB/Redis exposure, Cloudflare Tunnel |
| Extra files                | `Caddyfile`, `CERTIFICATES.md`, `rootCA.pem` | `EXPOSURE.md` (port table + SSE-safe Caddy/nginx snippets)                                                            |

## Quick start

```bash
mkdir -p ~/mysagra && cd ~/mysagra

docker run --rm -it \
  -v "$PWD":/out \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/mysagra/mywizard:latest
```

PowerShell (Windows):

```powershell
New-Item -ItemType Directory -Force -Path ~\mysagra | Out-Null
Set-Location ~\mysagra

docker run --rm -it `
  -v "${PWD}:/out" `
  -v /var/run/docker.sock:/var/run/docker.sock `
  ghcr.io/mysagra/mywizard:latest
```

Or use the convenience scripts shipped in the repository:

```bash
./install.sh                # Linux / macOS
.\install.ps1               # Windows (PowerShell)
```

> Mounting `/var/run/docker.sock` is only needed to let the installer start the stack (and extract
> Caddy's root CA). Without the socket the files are still generated.

## Try the wizard locally

The fastest way to see the wizard in action, without touching a real deployment:

```bash
cd installer
./scripts/try-wizard.sh            # builds from sources and runs the wizard in a temp folder
./scripts/try-wizard.sh --image    # builds the Docker image and runs the wizard inside it
./scripts/try-wizard.sh --dir ~/mysagra-test   # pick the output folder
```

The script runs the wizard, then prints the generated files, the `.env` (secrets masked) and the
resulting compose profiles. Nothing is started.

Manual equivalent:

```bash
cd installer && pnpm install && pnpm build
mkdir -p ~/mysagra-test
node dist/index.js --out ~/mysagra-test          # from sources

# or through the image (needs -it for the interactive prompts)
docker build -t mywizard:dev .
docker run --rm -it \
  -v ~/mysagra-test:/out \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  mywizard:dev
```

Suggested answers for a single-machine test: **Local network (LAN) (recommended)** → IP `127.0.0.1`
→ **Hostnames + direct IP (recommended)** → all services → advanced options `no` → _Start the stack_ `no` (start it manually
later, see [Local test](#local-test-real-stack)).

Wizard keys: `↑/↓` to move, `space` to toggle in multi-select, `enter` to confirm, `y`/`n` on
yes/no questions, `Ctrl+C` to abort (nothing is written).

## Non-interactive mode

```bash
docker run --rm -v "$PWD":/out ghcr.io/mysagra/mywizard:latest \
  --non-interactive \
  --mode lan \
  --server-ip 192.168.1.100 \
  --services mycassa,myadmin,mystampa,mynumeri,myclienti \
  --require-table \
  --no-show-numbers
```

Answers can also be stored in a JSON file (see [`examples/answers.json`](examples/answers.json) and
[`examples/answers.public.json`](examples/answers.public.json)):

```bash
docker run --rm -v "$PWD":/out -v "$PWD/answers.json":/answers.json:ro \
  ghcr.io/mysagra/mywizard:latest --non-interactive --config /answers.json
```

| Option                                          | Description                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-o, --out <dir>`                               | Output directory (default `/out`)                                                                                           |
| `--non-interactive`                             | No questions: use flags, `--config` and the existing `.env`                                                                 |
| `--config <file.json>`                          | JSON file holding the answers                                                                                               |
| `--setup <simple\|advanced>`                    | Setup type (default `simple`)                                                                                               |
| `--stack-name <name>`                           | Advanced: stack identifier; blank generates `mysagra-<id>`                                                                  |
| `--publish-ports`                               | Advanced: publish the service ports on the host (off by default)                                                            |
| `--port-offset <n>`                             | Advanced: offset added to every published host port                                                                         |
| `--connector <none\|cloudflare\|nginx>`         | Advanced: connector added to the stack (default `none`)                                                                     |
| `--cloudflare-token <t>`                        | Token used by the `cloudflare` connector                                                                                    |
| `--external-domain <d>`                         | Advanced: domain served by your own proxy (URLs become `https://<service>-<domain>`)                                        |
| `--trust-proxy-level <n>`                       | Advanced: number of proxies in front of the API                                                                             |
| `--mode <lan\|public>`                          | Simple: LAN (Caddy internal CA) or public domain (Let's Encrypt)                                                            |
| `--server-ip <ip>`                              | Server IP address / hostname                                                                                                |
| `--dns <hybrid\|sslip\|manual>`                 | Access mode: `hybrid` (default: sslip.io hostnames **and** direct IP), `sslip` (hostnames only), `manual` (your own domain) |
| `--host-prefix <name>`                          | Instance prefix: hosts become `cashier-<prefix>-<dom>`; also prefixes the compose project. Empty by default                 |
| `--base-domain <dom>`                           | Base domain with `--dns manual`: hosts become `cashier-<dom>`, `admin-<dom>`, …                                             |
| `--tls <caddy-internal\|caddy-acme>`            | Certificate strategy (derived from `--mode` when omitted)                                                                   |
| `--acme-email <email>`                          | ACME email (required with `caddy-acme`)                                                                                     |
| `--services <list>`                             | Comma separated profiles, or `all` / `none`                                                                                 |
| `--require-table[=bool]` / `--no-require-table` | `REQUIRE_TABLE`                                                                                                             |
| `--show-numbers[=bool]` / `--no-show-numbers`   | `SHOW_NUMBERS`                                                                                                              |
| `--project <name>`                              | Compose project name (default `mysagra`); use a different one to run several stacks on the same host                        |
| `--node-env <env>`                              | `production` (default) or `development`                                                                                     |
| `--expose-db`, `--expose-redis`                 | Publish MySQL/Redis on the host (not recommended)                                                                           |
| `--start` / `--no-start`                        | Start (or not) the stack when done                                                                                          |
| `--regenerate-secrets`                          | Regenerate secrets even if present in the `.env`                                                                            |

## Profiles and services

Always-on core: **backend**, **MySQL**, **Redis** (backend dependency). The **Caddy** proxy lives on
the `proxy` profile, which is always included.

| Profile     | Service          | Generated host     | Internal port                   |
| ----------- | ---------------- | ------------------ | ------------------------------- |
| _(core)_    | MySagra API      | `api-<domain>`     | 4300                            |
| _(core)_    | MySQL            | —                  | 3306                            |
| _(core)_    | Redis            | —                  | 6379                            |
| `proxy`     | Caddy            | —                  | 80/443 (only published service) |
| `mycassa`   | MyCassa          | `cashier-<domain>` | 3031                            |
| `myadmin`   | MyAmministratore | `admin-<domain>`   | 3000                            |
| `mystampa`  | MyStampa         | `print-<domain>`   | 3032                            |
| `mynumeri`  | MyNumeri         | `numbers-<domain>` | 3033                            |
| `myclienti` | MyClienti        | `clienti-<domain>` | 3034                            |
| `dbgate`    | DBGate           | `db-<domain>`      | 3000                            |

The selected profiles are stored in `COMPOSE_PROFILES` inside the `.env`, so you only need:

```bash
docker compose up -d                            # starts the selected profiles
docker compose --profile dbgate up -d dbgate    # one-off enablement
```

No application service publishes ports on the host: every request goes through Caddy (80/443, HTTP/3
included).

## Generated files

| File                   | Content                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `.env`                 | Configuration and secrets (`0600` permissions, `.env.bak` backup on every run) |
| `docker-compose.yml`   | Stack with profiles, healthchecks and hardening                                |
| `Caddyfile`            | Simple setup only: reverse proxy, TLS, security headers, SSE-safe snippet      |
| `CERTIFICATES.md`      | Simple setup: root CA trust instructions + ready-to-paste `hosts` entries      |
| `EXPOSURE.md`          | Advanced setup: upstreams/ports + SSE-safe proxy snippets                      |
| `nginx.conf`, `certs/` | Advanced setup with the nginx connector: starter config you own                |
| `rootCA.pem`           | Caddy internal root CA (simple setup, LAN mode)                                |
| `extract-rootca.sh`    | Re-extracts the root CA when the installer had no Docker socket                |
| `assets/`              | Asset folder mounted by MyStampa                                               |

## Main `.env` variables

The file is **dynamic**: it only contains the sections of the services you selected (one section per
service, plus General / Backend / Database / Redis). Nothing is written for disabled services.

| Variable                                                                         | Source                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES`                                                               | Selected profiles                                                                                                                                           |
| `SERVER_IP`, `DNS_MODE`, `BASE_DOMAIN`, `TLS_MODE`, `ACME_EMAIL`                 | Wizard answers                                                                                                                                              |
| `COMPOSE_PROJECT_NAME`                                                           | Compose project (prefix of containers and volumes)                                                                                                          |
| `DATABASE_URL`, `MYSQL_DATABASE`, `DB_USER`, `DB_USER_PASSWORD`, `ROOT_PASSWORD` | Derived + generated                                                                                                                                         |
| `REDIS_URL`, `REDIS_PASS`                                                        | Generated                                                                                                                                                   |
| `JWT_SECRET`, `PEPPER`                                                           | `node:crypto` (48/32 random bytes, hex)                                                                                                                     |
| `ALLOWED_ORIGINS`                                                                | Every enabled host                                                                                                                                          |
| `API_URL`, `AUTH_URL_CASSA`, `AUTH_URL_AMMINISTRATORE`, `AUTH_URL_NUMERI`        | `https://api-<domain>`                                                                                                                                      |
| `TRUST_PROXY_LEVEL`                                                              | `1` (Caddy is the only proxy)                                                                                                                               |
| `REQUIRE_TABLE`                                                                  | Ask the customer for a table number                                                                                                                         |
| `SHOW_NUMBERS`                                                                   | Sequential order number as main code instead of the display code                                                                                            |
| `MYSTAMPA_API_KEY`, `MYCLIENTI_API_KEY`                                          | **Not generated**: written as `ms_pt_CHANGE_ME` / `ms_wb_CHANGE_ME`, only when MyStampa/MyClienti are selected. A key you pasted is preserved on later runs |
| `DBGATE_USER`, `DBGATE_PASSWORD`                                                 | Generated, only with the `dbgate` profile                                                                                                                   |
| `AUTH_URL_CASSA`… , `URL_<SERVICE>`, `URL_<SERVICE>_IP`                          | Written only for the selected services                                                                                                                      |

## Advanced setup

```bash
docker run --rm -v "$PWD":/out ghcr.io/mysagra/mywizard:latest \
  --non-interactive --setup advanced \
  --stack-name sagra-paese --server-ip 10.0.0.5 \
  --services mycassa,myadmin,mystampa --port-offset 100 \
  --external-domain mysagra.example.com --trust-proxy-level 2
```

Default host ports (before the offset): API `4300`, MyCassa `3031`, MyStampa `3032`,
MyNumeri `3033`, MyClienti `3034`, MyAmministratore `3035`, DBGate `3036`
(+ MySQL `3306` / Redis `6379` only with `--expose-db` / `--expose-redis`).

Everything is namespaced by the stack name: compose project, container names (`sagra-paese-api`, …),
volumes and network, so **multiple stacks run side by side**.

By default **no port is published**: services live on the `<stack>_mysagra-network` docker network
only. The wizard asks whether to publish them; `EXPOSURE.md` explains both ways:

1. attach your proxy to the `<stack>_mysagra-network` network and use the internal upstreams
   (`mysagra-backend:4300`, `mycassa:3031`, …) — recommended, zero port conflicts;
2. publish the host ports (`--publish-ports`, shift them with `--port-offset`).

### Connector (optional, last question)

The advanced wizard ends with a skippable choice:

| Choice                | What the installer does                                                                                                                                                                                                                   | Flag                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Cloudflare Tunnel** | adds a `cloudflared` container (profile `cloudflared`) with your token; map the public hostnames in Zero Trust to the internal upstreams — no firewall port to open                                                                       | `--connector cloudflare --cloudflare-token <t>` |
| **nginx container**   | adds an `nginx:alpine` container (profile `nginx`) publishing 80/443, with a **starter** `nginx.conf` (SSE-safe proxy blocks) and a `certs/` folder: server names, TLS and routing are yours. An edited `nginx.conf` is never overwritten | `--connector nginx`                             |
| **Skip** (default)    | nothing is added: attach your own proxy to the `<stack>_mysagra-network` network                                                                                                                                                          | `--connector none`                              |

It also ships ready-to-use, SSE-safe Caddy and nginx snippets.

`--port-offset` and `--external-domain` are expert flags: the wizard does not ask for them, since
the stack talks over the internal docker network and ports/URLs can be edited afterwards in
`docker-compose.yml` / `.env`.

## Hostnames and DNS

Every service is published as `<service>-<base domain>`, or `<service>-<instance prefix>-<base
domain>` when an instance prefix is set. Three ways to make those names resolve:

| Mode                                | Base domain                                                              | Client setup                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `hybrid` **(default, recommended)** | `<server-ip-with-dashes>.sslip.io` **plus** direct `https://<ip>:<port>` | **none** — if DNS is unavailable the IP addresses still work   |
| `sslip`                             | `<server-ip-with-dashes>.sslip.io`                                       | **none**, but a public DNS resolver must be reachable          |
| `manual`                            | your own, e.g. `mysagra.lan`                                             | a record on your local DNS, or a `hosts` entry on every device |

Ports used by the direct IP access (published by Caddy, hybrid mode only):

| Service          | Hostname           | Direct IP            |
| ---------------- | ------------------ | -------------------- |
| MyCassa          | `cashier-<domain>` | `https://<ip>` (443) |
| MySagra API      | `api-<domain>`     | `https://<ip>:4443`  |
| MyAmministratore | `admin-<domain>`   | `https://<ip>:8443`  |
| MyStampa         | `print-<domain>`   | `https://<ip>:8444`  |
| MyNumeri         | `numbers-<domain>` | `https://<ip>:8445`  |
| MyClienti        | `clienti-<domain>` | `https://<ip>:8446`  |
| DBGate           | `db-<domain>`      | `https://<ip>:8447`  |

`sslip.io` is a public wildcard DNS resolver: it only translates the name into the IP already
contained in it, no traffic goes through it. Pick `manual` when the network has no internet access
or you run your own DNS.

> Avoid `.local` domains: they are reserved for mDNS and are frequently hijacked by the OS resolver,
> which is the usual reason a `hosts` entry seems to be ignored. Prefer `.lan`, `.home.arpa` or
> sslip.io.

### Multiple instances (simple setup)

The wizard asks for an optional **instance prefix** (press Enter for none, which is the normal case
with a single installation). With a prefix like `sagra1`:

- hostnames become `cashier-sagra1-<domain>`, `admin-sagra1-<domain>`, …
- the compose project becomes `mysagra-sagra1`, so containers and volumes never collide

Two **simple** stacks cannot share a host: both need ports 80/443. For several stacks on one
machine use the **advanced setup** (different stack name + port offset) and put a single proxy of
your own in front of them.

## Certificates

- **LAN** (`--mode lan`): Caddy uses its own **internal CA**. The installer starts Caddy, extracts
  `/data/caddy/pki/authorities/local/root.crt` into `rootCA.pem` and mounts it into the containers
  (`NODE_EXTRA_CA_CERTS`). Clients must trust the root CA and resolve the hostnames (see
  `CERTIFICATES.md`, which includes ready-to-paste `hosts` entries).
- **Public** (`--mode public`): automatic **Let's Encrypt** certificates; public DNS records must
  point to the server and ports 80/443 must be reachable.

## Final summary

When the installer finishes it prints how to reach every enabled service (hostname and, in hybrid
mode, the direct IP URL), the **admin panel default credentials** (`admin` / `admin`, to be changed
at first login), the generated **DBGate credentials**, and the remaining manual steps (root CA
trust and API key creation).

## SSE

The `Caddyfile` uses a dedicated snippet for every upstream:

```
reverse_proxy <service>:<port> {
    flush_interval -1          # no response buffering
    header_down X-Accel-Buffering no
    transport http { read_timeout 0  write_timeout 0 }
}
```

so `text/event-stream` responses are never buffered nor closed by timeouts; compression is limited
to static/JSON content types.

## Local test (real stack)

Full run on a single machine, with real containers.

**1. Generate the configuration** (wizard or one-liner):

```bash
mkdir -p ~/mysagra-test
docker run --rm -v ~/mysagra-test:/out -u "$(id -u):$(id -g)" -e HOME=/tmp \
  mywizard:dev --non-interactive \
  --mode lan --server-ip 127.0.0.1 --services all --no-start
```

**2. Hostnames**: with the default `hybrid` mode there is nothing to do — the generated names
(`api-127-0-0-1.sslip.io`, `cashier-127-0-0-1.sslip.io`, …) already resolve. Just make sure ports
80/443 are free. With `--dns manual` add the entries listed in `CERTIFICATES.md` to `/etc/hosts`.

**3. Start the stack** (skip if the wizard already did it):

```bash
cd ~/mysagra-test
docker compose up -d                       # uses COMPOSE_PROFILES from .env
docker compose ps
docker compose logs -f mysagra-backend     # migrations run on first boot
```

**4. Get the root CA** (only needed when you started the stack manually):

```bash
cd ~/mysagra-test && ./extract-rootca.sh
```

**5. Check TLS, routing and SSE:**

```bash
cd ~/mysagra-test
curl --cacert rootCA.pem https://api-127-0-0-1.sslip.io/health
curl --cacert rootCA.pem https://127.0.0.1:4443/health                 # direct IP access
curl --cacert rootCA.pem -N https://api-127-0-0-1.sslip.io/<sse-path>   # SSE stream stays open
curl --cacert rootCA.pem -I https://cashier-127-0-0-1.sslip.io
grep DBGATE .env                                                   # DBGate credentials

# service-to-service call through Caddy (public hostnames resolve inside the network too)
docker compose exec mycassa node -e 'fetch(process.env.AUTH_URL+"/health").then(r=>r.text()).then(console.log)'
```

With `--dns manual` and no hosts entry you can still test with `--resolve`:

```bash
curl --cacert rootCA.pem --resolve api-mysagra.lan:443:127.0.0.1 https://api-mysagra.lan/health
```

In the browser: `https://admin-127-0-0-1.sslip.io`, `https://cashier-127-0-0-1.sslip.io`,
`https://db-127-0-0-1.sslip.io`. To avoid certificate warnings, trust the root CA:

```bash
sudo cp ~/mysagra-test/rootCA.pem /usr/local/share/ca-certificates/mysagra-rootCA.crt
sudo update-ca-certificates
```

**6. Check the profiles:**

```bash
docker compose ps --services                    # only the enabled profiles are running
docker compose --profile dbgate up -d dbgate    # one-off enablement
```

**7. Clean up:**

```bash
cd ~/mysagra-test
docker compose --profile "*" down -v
rm -rf ~/mysagra-test
```

## Updating the configuration

Running the installer again in the same folder reuses the existing `.env` as defaults and **keeps the
secrets** (idempotency). Use `--regenerate-secrets` to force new ones.

## Development

```bash
cd installer
corepack enable && corepack prepare pnpm@12.4.2 --activate
pnpm install
pnpm dev -- --non-interactive --out /tmp/mysagra --server-ip 192.168.1.10 --base-domain mysagra.local
pnpm check          # typecheck + eslint + prettier
pnpm build
docker build -t mywizard:dev .
```

### Scripts

| Script                    | Purpose                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/try-wizard.sh` | Run the interactive wizard in a throwaway folder (`--image` to use the container)                                                                                 |
| `./scripts/test-local.sh` | Checks: typecheck, build, generation, `docker compose config`, `caddy validate`, idempotency, ACME mode, validation errors (`--image` also builds/runs the image) |

Both work in temporary folders and never start the stack, so they cannot affect an existing
deployment. For a real run with containers see [Local test](#local-test-real-stack).

### Versioning

The version printed by `--version` and shown in the wizard banner is injected at build time:

```bash
APP_VERSION=v1.4.2 pnpm build     # local
docker build --build-arg APP_VERSION=1.4.2 -t mywizard .
```

In CI it comes from the git tag (`docker/metadata-action` output), so `ghcr.io/<owner>/mywizard:1.4.2`
reports `1.4.2`; without a tag it falls back to `package.json`.

### CI

- `.github/workflows/installer-ci.yml`: install → typecheck → build → smoke test (`docker compose
config`, `caddy validate`, idempotency check) on every push/PR touching `installer/`.
- `.github/workflows/installer-image.yml`: multi-arch build (`linux/amd64`, `linux/arm64`) pushed to
  `ghcr.io/<owner>/mywizard` on `main` pushes and `v*` tags, tagged `latest`, semver and `sha`.
