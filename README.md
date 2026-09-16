# MyWizard — MySagra deployment wizard

This repository contains the tooling used to deploy a MySagra stack with Docker Compose.

| Path | Description |
| --- | --- |
| `installer/` | **MyWizard**: ephemeral Docker image (TypeScript CLI) that asks a few questions and generates `docker-compose.yml`, `.env`, `Caddyfile` and the certificate docs |
| `install.sh` / `install.ps1` | One-liner wrappers that run the installer image with the right mounts |
| `docker-compose.example.yml` | Reference compose file (the installer generates a tailored one) |

## Install

```bash
mkdir -p ~/mysagra && cd ~/mysagra
curl -fsSLO https://raw.githubusercontent.com/MySagra/mysagra/main/install.sh
chmod +x install.sh
./install.sh
```

or directly:

```bash
docker run --rm -it \
  -v "$PWD":/out \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/mysagra/mywizard:latest
```

The installer runs once, writes the configuration into the current folder and removes itself
(`--rm`). It can also start the stack for you.

Full documentation: [`installer/README.md`](installer/README.md).

## Try it locally

```bash
cd installer
./scripts/try-wizard.sh          # interactive wizard in a throwaway folder
./scripts/try-wizard.sh --image  # same, running the Docker image
./scripts/test-local.sh          # non-interactive checks (compose/caddy validation, idempotency)
```

To run the whole stack on your machine (hosts entries, startup, TLS/SSE checks, teardown) follow
[Local test (real stack)](installer/README.md#local-test-real-stack).

## Simple vs advanced setup

- **Simple (default)**: one command, self-contained stack with a bundled Caddy that handles TLS and
  hostnames. Perfect for a single installation on a machine.
- **Advanced**: no bundled proxy; every service is published on a host port and the stack is fully
  namespaced by a stack name (asked by the wizard, generated when left blank), so several stacks can
  run on the same machine behind a reverse proxy you manage. `EXPOSURE.md` documents the ports and
  ships SSE-safe Caddy/nginx snippets.

```bash
./install.sh --non-interactive --setup advanced --stack-name sagra-paese \
  --server-ip 10.0.0.5 --port-offset 100 --services all
```

## Services and profiles

Core services (always on): MySagra API, MySQL, Redis, plus the Caddy reverse proxy (`proxy`
profile). Optional profiles: `mycassa`, `myadmin`, `mystampa`, `mynumeri`, `myclienti`, `dbgate`.

Only Caddy publishes ports (80/443); everything else is reachable through
`https://<service>-<base-domain>` with automatic TLS (internal CA on LAN, Let's Encrypt in public
mode) and SSE-friendly proxying.

By default (`--dns hybrid`) every service is published **both** as a sslip.io hostname
(`cashier-192-168-1-100.sslip.io` → `192.168.1.100`) **and** on a direct IP address
(`https://192.168.1.100`, `https://192.168.1.100:8443`, …), so phones, tablets and PCs reach the
stack without editing any `hosts` file and even when DNS is unavailable. Alternatives:
`--dns sslip` (hostnames only) or `--dns manual --base-domain mysagra.lan` (your own domain).
