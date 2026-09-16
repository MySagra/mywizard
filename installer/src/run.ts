import pc from "picocolors";
import type { DerivedConfig } from "./derive.js";
import type { DockerRunner } from "./tls.js";
import { extractInternalRootCa } from "./tls.js";
import { execa } from "execa";
import { isPullLine, stripAnsi, summarizeComposeLine, type Reporter } from "./progress.js";

export interface StartResult {
  ok: boolean;
  rootCaExtracted: boolean;
  error?: string;
}

export interface StartOptions {
  /** true when the DB password was generated now (not reused from an existing .env) */
  freshDbSecret: boolean;
}

/**
 * Detects a MySQL volume left over from a previous installation: its data was
 * initialised with different credentials, so the backend would fail to connect.
 */
async function checkStaleDataVolume(derived: DerivedConfig): Promise<string | undefined> {
  const project = derived.answers.projectName;
  const volume = `${project}_mysql_data`;
  try {
    const { stdout } = await execa("docker", ["volume", "ls", "--format", "{{.Name}}"]);
    if (!stdout.split("\n").includes(volume)) return undefined;
  } catch {
    return undefined;
  }
  return (
    `The volume "${volume}" already exists and was initialised with different database ` +
    "credentials, so the backend cannot authenticate.\n" +
    "Choose one of:\n" +
    `  • reuse the previous configuration: run the installer in the folder holding that .env\n` +
    `  • wipe the old data:   docker compose -p ${project} down -v\n` +
    `  • use another project: set COMPOSE_PROJECT_NAME in .env (or --project <name>)`
  );
}

/**
 * Runs a compose command forwarding its output to the reporter as a single
 * overwritten status line instead of dumping every log line.
 */
async function streamed(
  runner: DockerRunner,
  args: string[],
  reporter: Reporter,
  phase: string,
  pullPhase?: string,
): Promise<void> {
  const proc = runner.compose(args);
  let pulling = false;
  let buffer = "";
  const tail: string[] = [];

  const handle = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (pullPhase && !pulling && isPullLine(line)) {
        pulling = true;
        reporter.start(pullPhase);
      }
      const clean = stripAnsi(line).trim();
      if (clean) {
        tail.push(clean);
        if (tail.length > 8) tail.shift();
      }
      const status = summarizeComposeLine(line);
      if (status) reporter.update(status);
    }
  };

  proc.stdout?.on("data", handle);
  proc.stderr?.on("data", handle);
  try {
    await proc;
  } catch (error) {
    // surface the last compose lines: they carry the real reason of the failure
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error([reason, ...tail].join("\n"), { cause: error });
  }
  if (pulling) reporter.start(phase);
}

/**
 * Starts the stack: Caddy first (for the internal CA), then every service of
 * the selected profiles, waiting for the backend healthcheck.
 */
export async function startStack(
  derived: DerivedConfig,
  runner: DockerRunner,
  reporter: Reporter,
  options: StartOptions,
): Promise<StartResult> {
  const profiles = derived.composeProfiles.split(",").flatMap((p) => ["--profile", p]);
  let rootCaExtracted = false;

  try {
    if (options.freshDbSecret) {
      const stale = await checkStaleDataVolume(derived);
      if (stale) return { ok: false, rootCaExtracted, error: stale };
    }

    if (derived.usesInternalCa) {
      reporter.start("Preparing Caddy and its internal CA…");
      rootCaExtracted = await extractInternalRootCa(derived.answers.outputDir, runner, (msg) =>
        reporter.update(msg),
      );
      if (rootCaExtracted) {
        reporter.stop("Internal root CA written to rootCA.pem");
      } else {
        reporter.stop(
          pc.yellow("Could not extract Caddy's root CA: run ./extract-rootca.sh later."),
        );
      }
    }

    reporter.start("Starting the stack…");
    await streamed(
      runner,
      [...profiles, "up", "-d"],
      reporter,
      "Starting the stack…",
      "Downloading container images (this may take a few minutes)…",
    );
    reporter.stop("Containers started");

    // the Caddyfile is bind-mounted: `up -d` does not recreate Caddy, so make
    // sure a regenerated configuration is applied
    try {
      await runner.compose([
        "exec",
        "-T",
        "caddy",
        "caddy",
        "reload",
        "--config",
        "/etc/caddy/Caddyfile",
      ]);
    } catch {
      // Caddy may still be booting: it will load the file on its own
    }

    reporter.start("Waiting for the backend to become healthy…");
    const healthy = await waitForHealthy(runner, "mysagra-backend", 60, reporter);
    if (!healthy) {
      reporter.stop(pc.red("The backend did not become healthy"));
      return {
        ok: false,
        rootCaExtracted,
        error: "The backend never became healthy: check `docker compose logs mysagra-backend`",
      };
    }
    reporter.stop("Backend is healthy");

    if (rootCaExtracted) {
      // services started before the extraction must reload the CA bundle
      reporter.start("Restarting services with the new root CA…");
      await streamed(runner, [...profiles, "restart"], reporter, "Restarting services…");
      reporter.stop("Services restarted");
    }

    return { ok: true, rootCaExtracted };
  } catch (error) {
    reporter.stop(pc.red("Startup failed"));
    const message = error instanceof Error ? error.message : String(error);
    const hint = await dbAuthHint(derived, runner);
    return {
      ok: false,
      rootCaExtracted,
      error: hint ? `${message}\n\n${hint}` : message,
    };
  }
}

/**
 * Detects the classic "stale MySQL volume" failure: the database was created
 * with different credentials than the ones in the current .env.
 */
async function dbAuthHint(
  derived: DerivedConfig,
  runner: DockerRunner,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner.compose(["logs", "--tail", "30", "mysagra-backend"]);
    if (!/P1000|Authentication failed against database/i.test(stdout)) return undefined;
  } catch {
    return undefined;
  }
  const project = derived.answers.projectName;
  return (
    "The database rejected the credentials: the MySQL volume was created by a previous\n" +
    "installation with different secrets. Fix it with one of:\n" +
    `  • wipe the old data:   docker compose -p ${project} down -v\n` +
    `  • use another project: --project <name> (or COMPOSE_PROJECT_NAME in .env)\n` +
    "  • restore the previous .env in this folder"
  );
}

async function waitForHealthy(
  runner: DockerRunner,
  service: string,
  attempts: number,
  reporter: Reporter,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { stdout } = await runner.compose(["ps", "--format", "json", service]);
      // `docker compose ps --format json` prints one JSON object per line
      const rows = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line): Array<{ Health?: string; State?: string }> => {
          try {
            const parsed = JSON.parse(line) as
              { Health?: string; State?: string } | Array<{ Health?: string; State?: string }>;
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return [];
          }
        });
      if (rows.length > 0) {
        if (rows.every((r) => r.Health === "healthy")) return true;
        if (rows.some((r) => r.State === "exited" || r.State === "dead")) return false;
      }
    } catch {
      // the service may not be registered yet
    }
    reporter.update(`${i * 5}s elapsed`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Final summary with URLs, credentials and next steps. */
export function summary(derived: DerivedConfig, secrets: Record<string, string>): string {
  const width = Math.max(...derived.endpoints.map((e) => e.service.label.length));
  const rows = derived.endpoints.map((e) => {
    const main = `  ${e.service.label.padEnd(width)}  ${pc.cyan(e.url)}`;
    return e.ipUrl ? `${main}\n  ${" ".repeat(width)}  ${pc.cyan(e.ipUrl)}` : main;
  });
  const lines = [
    pc.bold(
      derived.proxyEnabled || derived.answers.publishPorts
        ? "How to reach the services"
        : "Internal upstreams (reachable from the docker network)",
    ),
    ...rows,
    "",
  ];

  if (!derived.proxyEnabled) {
    lines.push(
      pc.dim(
        derived.answers.publishPorts
          ? `  Stack "${derived.answers.stackName}" has no proxy: put your own in front of these ports.`
          : `  Stack "${derived.answers.stackName}" is internal-only: attach your proxy to the ` +
              `${derived.answers.projectName}_mysagra-network network (see EXPOSURE.md).`,
      ),
      ...(derived.cloudflareEnabled
        ? [pc.dim("  A Cloudflare Tunnel connector is running: map the hostnames in Zero Trust.")]
        : []),
      "",
    );
  }

  if (derived.proxyEnabled && derived.answers.dns !== "manual") {
    lines.push(
      pc.dim(
        derived.hasIpAccess
          ? "  Hostnames resolve automatically (sslip.io); the IP addresses work even without DNS."
          : "  Hostnames resolve automatically through sslip.io, no client setup needed.",
      ),
      "",
    );
  }

  if (derived.answers.services.includes("myadmin")) {
    lines.push(
      pc.bold("Admin panel credentials (default)"),
      "  user:     admin",
      "  password: admin",
      pc.dim("  Change them right after the first login."),
      "",
    );
  }

  if (derived.answers.services.includes("dbgate")) {
    lines.push(
      pc.bold("DBGate credentials"),
      `  user:     ${secrets.DBGATE_USER}`,
      `  password: ${secrets.DBGATE_PASSWORD}`,
      "",
    );
  }

  lines.push(
    pc.bold("Next steps"),
    `  1. ${
      !derived.proxyEnabled
        ? `Wire the published ports into your reverse proxy (see ${derived.answers.outputDir}/EXPOSURE.md)`
        : derived.answers.tls === "caddy-internal"
          ? `Install rootCA.pem on your devices (see ${derived.answers.outputDir}/CERTIFICATES.md)`
          : "Make sure DNS records point to the server"
    }`,
    `  2. Open ${pc.cyan(
      derived.endpoints.find((e) => e.service.id === "myamministratore")?.url ?? "the admin panel",
    )} and create the API keys`,
    "     • PRINTER type → paste into MYSTAMPA_API_KEY  (replaces ms_pt_CHANGE_ME)",
    "     • WEBAPP type  → paste into MYCLIENTI_API_KEY (replaces ms_wb_CHANGE_ME)",
    "  3. Save the .env and restart: docker compose restart mystampa myclienti",
  );
  return lines.join("\n");
}
