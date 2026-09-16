import { writeFileSync, existsSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execa } from "execa";
import type { DerivedConfig } from "./derive.js";

export const CADDY_ROOT_CA_PATH = "/data/caddy/pki/authorities/local/root.crt";
const EXTRACT_SCRIPT = "extract-rootca.sh";

/** `docker compose` process with stream stdout/stderr and a typed result. */
export interface ComposeProcess extends Promise<{ stdout: string; stderr: string }> {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
}

export interface DockerRunner {
  compose: (args: string[]) => ComposeProcess;
}

export function dockerAvailable(): boolean {
  return existsSync("/var/run/docker.sock");
}

export function makeRunner(outputDir: string, projectDir: string): DockerRunner {
  return {
    compose: (args: string[]) =>
      execa(
        "docker",
        [
          "compose",
          "--project-directory",
          projectDir,
          "-f",
          join(outputDir, "docker-compose.yml"),
          "--env-file",
          join(outputDir, ".env"),
          ...args,
        ],
        {
          cwd: outputDir,
          stdio: "pipe",
          encoding: "utf8",
        },
      ),
  };
}

/**
 * The installer normally runs inside its own container
 * (`docker run -v $PWD:/out -v /var/run/docker.sock:... ghcr.io/mysagra/mywizard`),
 * so `docker compose` here talks to the *host* daemon over the socket while
 * `outputDir` ("/out") only exists inside our own container. Passing
 * `--project-directory outputDir` (the previous behaviour) makes compose
 * resolve every relative path in the generated compose file against "/out":
 *
 * - bind-mount volumes (Caddyfile, rootCA.pem, nginx.conf, certs/, assets/)
 *   are resolved into a plain string handed to the *daemon*, which then
 *   receives "/out/Caddyfile" — a path that doesn't exist on the real host,
 *   so Docker silently creates it as a directory instead of the expected
 *   file, breaking the mount.
 * - `env_file: .env` entries are read by the *compose CLI itself* (to build
 *   each container's environment), so it needs an actual, container-local
 *   readable path, not a host-only one.
 *
 * Ask the daemon (via `docker inspect` on our own container) for the real
 * host-side path bind-mounted at `outputDir`. That path fixes the volumes,
 * but is invisible inside our own container (it only exists on the host), so
 * `env_file: .env` would then fail to resolve instead. Symlinking it to our
 * own bind-mounted copy satisfies both at once: compose (running in this
 * container) reads `.env` through the symlink, while the daemon (on the
 * host) resolves the same path to the real, already-existing folder.
 *
 * Running the installer directly on the host (outside a container) has no
 * such mount to find, so this safely falls back to `outputDir` unchanged.
 */
const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Docker Desktop's WSL2 backend hands back the *raw Windows path*
 * (`C:\Users\...`) as the bind-mount `Source` on `docker inspect`, but our
 * own `docker compose` process runs inside this Linux container. Go's
 * `filepath.IsAbs` there only recognises a leading `/`, so a drive-letter
 * path is (wrongly) treated as relative and joined onto compose's cwd,
 * producing something like `/out/C:\Users\...\Caddyfile` — which then fails
 * to parse as `SRC:DST:MODE` ("too many colons": the drive letter adds one).
 *
 * `/run/desktop/mnt/host/<drive>/...` is the path Docker Desktop's daemon
 * itself uses to reach the Windows host filesystem from inside its WSL2
 * utility VM, so it resolves bind mounts correctly *and* starts with `/`,
 * which satisfies compose's absolute-path check on the Linux side.
 */
function toDockerDesktopHostPath(hostPath: string): string {
  const match = WINDOWS_DRIVE_PATH.exec(hostPath);
  if (!match) return hostPath;
  const [, drive, rest] = match;
  return `/run/desktop/mnt/host/${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`;
}

export async function resolveHostProjectDir(outputDir: string): Promise<string> {
  const containerId = process.env.HOSTNAME;
  if (!containerId) return outputDir;
  try {
    const { stdout } = await execa("docker", [
      "inspect",
      containerId,
      "--format",
      "{{json .Mounts}}",
    ]);
    const mounts = JSON.parse(stdout) as Array<{ Destination: string; Source: string }>;
    const rawHostDir = mounts.find((m) => m.Destination === outputDir)?.Source;
    if (!rawHostDir || rawHostDir === outputDir) return outputDir;
    const hostDir = toDockerDesktopHostPath(rawHostDir);

    if (!existsSync(hostDir)) {
      mkdirSync(dirname(hostDir), { recursive: true });
      symlinkSync(outputDir, hostDir);
    }
    return hostDir;
  } catch {
    return outputDir;
  }
}

/** Creates a placeholder rootCA.pem so bind mounts do not fail on the first start. */
export function ensureRootCaPlaceholder(outputDir: string): void {
  const path = join(outputDir, "rootCA.pem");
  if (!existsSync(path)) {
    writeFileSync(path, "# placeholder: will be replaced by Caddy's internal root CA\n", "utf8");
  }
}

/**
 * Starts Caddy, waits for the internal PKI to be generated and extracts the
 * root CA into <outputDir>/rootCA.pem.
 */
export async function extractInternalRootCa(
  outputDir: string,
  runner: DockerRunner,
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  onProgress?.("Starting Caddy to generate the internal CA…");
  await runner.compose(["--profile", "proxy", "up", "-d", "caddy"]);

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const { stdout } = await runner.compose(["exec", "-T", "caddy", "cat", CADDY_ROOT_CA_PATH]);
      if (stdout.includes("BEGIN CERTIFICATE")) {
        writeFileSync(
          join(outputDir, "rootCA.pem"),
          stdout.endsWith("\n") ? stdout : stdout + "\n",
        );
        onProgress?.("Internal root CA extracted to rootCA.pem");
        return true;
      }
    } catch {
      // Caddy has not generated the PKI yet: retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Fallback script for when the docker socket is not available to the installer. */
export function writeExtractScript(outputDir: string): string {
  const path = join(outputDir, EXTRACT_SCRIPT);
  const content = `#!/usr/bin/env sh
# Extracts Caddy's internal root CA and restarts the services using it.
set -eu
cd "$(dirname "$0")"
docker compose --profile proxy up -d caddy
echo "Waiting for the internal CA to be generated…"
for i in $(seq 1 30); do
  if docker compose exec -T caddy cat ${CADDY_ROOT_CA_PATH} > rootCA.pem 2>/dev/null; then
    if grep -q "BEGIN CERTIFICATE" rootCA.pem; then
      echo "rootCA.pem created."
      docker compose up -d
      exit 0
    fi
  fi
  sleep 2
done
echo "Could not extract the root CA: check 'docker compose logs caddy'." >&2
exit 1
`;
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Advanced setup: the stack has no proxy, so document the published ports and
 * how to wire them into an existing reverse proxy (SSE-safe snippets included).
 */
export function generateExposureDoc(derived: DerivedConfig): string {
  const { answers } = derived;
  const lines: string[] = [
    `# Exposing the stack "${answers.stackName}"`,
    "",
    "This stack runs **without a reverse proxy**. Two ways to expose it with your own proxy:",
    "",
    `1. **Docker network** (recommended): attach your proxy to the \`${answers.projectName}_mysagra-network\``,
    "   network and use the service names as upstreams (`mysagra-backend:4300`, `mycassa:3031`, …).",
    derived.answers.publishPorts
      ? "2. **Host ports**: every service is also published on the host ports listed below."
      : "2. **Host ports**: disabled — re-run the installer with `--publish-ports` to enable them.",
    "",
    "Both the ports and the URLs can be changed directly in `docker-compose.yml` / `.env`.",
    "",
    "| Service | Internal upstream | Host port | Suggested public hostname |",
    "| --- | --- | --- | --- |",
    ...derived.endpoints.map(
      (e) =>
        `| ${e.service.label} | \`${e.service.id}:${e.service.port}\` | \`${e.hostPort ?? "—"}\` | \`${
          answers.externalDomain ? e.host : `${e.service.subdomain}-<your-domain>`
        }\` |`,
    ),
    "",
    `Compose project: \`${answers.projectName}\`${
      answers.portOffset ? `. Port offset applied: \`${answers.portOffset}\`` : ""
    }.`,
    "",
    "## Caddy snippet (SSE-safe)",
    "",
    "```caddyfile",
    ...derived.endpoints.flatMap((e) => [
      `${answers.externalDomain ? e.host : `${e.service.subdomain}-example.com`} {`,
      `\treverse_proxy ${e.hostPort ? `127.0.0.1:${e.hostPort}` : `${e.service.id}:${e.service.port}`} {`,
      "\t\tflush_interval -1",
      "\t\theader_down X-Accel-Buffering no",
      "\t\ttransport http {",
      "\t\t\tread_timeout 0",
      "\t\t\twrite_timeout 0",
      "\t\t}",
      "\t}",
      "}",
      "",
    ]),
    "```",
    "",
    "## nginx snippet (SSE-safe)",
    "",
    "```nginx",
    "location / {",
    `    proxy_pass http://${
      derived.api.hostPort ? `127.0.0.1:${derived.api.hostPort}` : "mysagra-backend:4300"
    };`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Connection '';",
    "    proxy_buffering off;",
    "    proxy_cache off;",
    "    proxy_read_timeout 24h;",
    "    chunked_transfer_encoding off;",
    "}",
    "```",
    "",
    "## Notes",
    "",
    `- \`TRUST_PROXY_LEVEL=${answers.trustProxyLevel}\` must match the number of proxies in front of the API.`,
    "- `ALLOWED_ORIGINS`, `API_URL` and `AUTH_URL_*` in the .env must match the public URLs served",
    "  by your proxy: update them and restart the affected services.",
    "- TLS certificates are handled by your proxy: the stack speaks plain HTTP.",
    ...(derived.nginxEnabled
      ? [
          "- An **nginx** container is part of the stack: edit `nginx.conf` (server names, TLS,",
          "  routing) and reload it with `docker compose restart nginx`. Certificates go in `./certs`.",
        ]
      : []),
    ...(derived.cloudflareEnabled
      ? [
          "- A **Cloudflare Tunnel** connector (`cloudflared`) runs inside the stack: configure the",
          "  public hostnames in the Zero Trust dashboard pointing to the internal upstreams above.",
        ]
      : []),
    "",
  ];
  return lines.join("\n");
}

/** Document with certificate trust instructions and hosts file entries. */
export function generateCertDoc(derived: DerivedConfig): string {
  const { answers } = derived;
  const lines: string[] = [];
  lines.push("# Certificates and DNS — MySagra");
  lines.push("");

  if (answers.tls === "caddy-acme") {
    lines.push(
      "The stack uses **Let's Encrypt** certificates issued automatically by Caddy: no action is",
      "required on client devices. Make sure the following hostnames point to the server and that",
      "ports 80/443 are reachable from the internet:",
      "",
      ...derived.endpoints.map((e) => `- \`${e.host}\` → ${answers.serverIp}`),
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    "The stack uses **Caddy's internal CA**. The `rootCA.pem` file in this folder must be installed",
    "as a trusted authority on every device that accesses MySagra.",
    "",
    "## 1. DNS resolution",
    "",
  );

  if (answers.dns === "hybrid") {
    lines.push(
      "Services are reachable in two ways, no client configuration needed:",
      "",
      ...derived.endpoints.map(
        (e) => `- **${e.service.label}**: ${e.url}${e.ipUrl ? ` — or ${e.ipUrl}` : ""}`,
      ),
      "",
      `The \`*-${answers.baseDomain}\` names resolve through sslip.io wildcard DNS; the direct IP`,
      "addresses keep working even without any DNS (offline network, captive portal, …).",
      "",
    );
  } else if (answers.dns === "sslip") {
    lines.push(
      "Hostnames use **sslip.io** wildcard DNS, so every device resolves them automatically as long",
      `as it can reach a public DNS server. \`<name>-${answers.serverIp.replace(/\./g, "-")}.sslip.io\``,
      `always resolves to \`${answers.serverIp}\`. Nothing to configure on the clients.`,
      "",
      "If your network has no internet access, re-run the installer with `--dns manual` and your own",
      "domain, then add the entries below to each device.",
      "",
      "```",
      ...derived.hostsEntries,
      "```",
      "",
    );
  } else {
    lines.push(
      "Add these lines to the hosts file of every device (or create the records on your local DNS):",
      "",
      "```",
      ...derived.hostsEntries,
      "```",
      "",
      "- Linux/macOS: `/etc/hosts`",
      "- Windows: `C:\\Windows\\System32\\drivers\\etc\\hosts`",
      "",
    );
  }

  lines.push(
    "## 2. Installing the root CA",
    "",
    "### Windows (PowerShell as administrator)",
    "```powershell",
    "Import-Certificate -FilePath .\\rootCA.pem -CertStoreLocation Cert:\\LocalMachine\\Root",
    "```",
    "",
    "### macOS",
    "```bash",
    "sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem",
    "```",
    "",
    "### Linux (Debian/Ubuntu)",
    "```bash",
    "sudo cp rootCA.pem /usr/local/share/ca-certificates/mysagra-rootCA.crt",
    "sudo update-ca-certificates",
    "```",
    "",
    "### Android",
    "Settings → Security → Install a certificate → CA certificate → select `rootCA.pem`.",
    "",
    "### iOS / iPadOS",
    "Send the file to the device, install it, then go to Settings → General → VPN & Device Management",
    "→ Certificate Trust Settings and enable full trust.",
    "",
    "## 3. Regenerating the root CA",
    "",
    "```bash",
    `./${EXTRACT_SCRIPT}`,
    "```",
    "",
  );
  return lines.join("\n");
}
