import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { log } from "@clack/prompts";
import { parseCli, resolveNonInteractive, HELP_TEXT } from "./config/cli.js";
import { answersSchema, formatZodError, type Answers } from "./config/schema.js";
import { runWizard, wizardOutro } from "./prompts/wizard.js";
import { readEnvFile, writeEnvFile } from "./env-file.js";
import { resolveSecrets } from "./secrets.js";
import { derive } from "./derive.js";
import { generateEnv } from "./generate/env.js";
import { generateCompose } from "./generate/compose.js";
import { generateCaddyfile } from "./generate/caddy.js";
import { generateNginxConf } from "./generate/nginx.js";
import {
  dockerAvailable,
  ensureRootCaPlaceholder,
  generateCertDoc,
  generateExposureDoc,
  makeRunner,
  writeExtractScript,
} from "./tls.js";
import { startStack, summary } from "./run.js";
import { createReporter } from "./progress.js";

/** Replaced at build time by tsup (APP_VERSION env / package.json). */
declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0-dev";
const CERT_DOC = "CERTIFICATES.md";
const EXPOSURE_DOC = "EXPOSURE.md";

/** Writes a file, keeping a `.bak` copy of the previous version. */
function writeWithBackup(path: string, content: string, backup = true): void {
  if (backup && existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, content, "utf8");
}

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    console.error(HELP_TEXT);
    return 2;
  }

  if (cli.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (cli.version) {
    console.log(VERSION);
    return 0;
  }
  if (!cli.nonInteractive && !cli.help) {
    // shown in the wizard banner
    process.env.MYWIZARD_VERSION = VERSION;
  }

  const outputDir = cli.outputDir;
  mkdirSync(outputDir, { recursive: true });
  const envPath = join(outputDir, ".env");
  const existingEnv = readEnvFile(envPath);
  const docker = dockerAvailable();

  let answers: Answers;
  if (cli.nonInteractive) {
    try {
      answers = resolveNonInteractive(cli, envPath).answers;
    } catch (error) {
      console.error(pc.red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  } else {
    if (!process.stdin.isTTY) {
      console.error(
        pc.red(
          "No interactive terminal available.\n" +
            "Use `docker run --rm -it …` for the wizard, or --non-interactive with configuration flags.",
        ),
      );
      console.error(HELP_TEXT);
      return 2;
    }
    const preset = cli.preset as Partial<Answers>;
    answers = await runWizard({
      existingEnv,
      dockerAvailable: docker,
      outputDir,
      preset: cli.regenerateSecrets ? { ...preset, regenerateSecrets: true } : preset,
    });
  }

  if (cli.regenerateSecrets) answers.regenerateSecrets = true;
  if (!docker) answers.startStack = false;

  const validated = answersSchema.safeParse(answers);
  if (!validated.success) {
    console.error(pc.red(`Invalid configuration:\n${formatZodError(validated.error)}`));
    return 1;
  }
  answers = validated.data;

  const derived = derive(answers);
  // DBGate credentials are only needed when the dbgate profile is enabled
  const skipSecrets = answers.services.includes("dbgate") ? [] : ["DBGATE_USER", "DBGATE_PASSWORD"];
  const { secrets, reused, generated } = resolveSecrets(
    existingEnv,
    answers.regenerateSecrets,
    skipSecrets,
  );

  // ── write files ──
  const backupPath = writeEnvFile(envPath, generateEnv(derived, secrets, existingEnv));
  writeWithBackup(join(outputDir, "docker-compose.yml"), generateCompose(derived));
  if (derived.proxyEnabled) {
    writeWithBackup(join(outputDir, "Caddyfile"), generateCaddyfile(derived));
    writeWithBackup(join(outputDir, CERT_DOC), generateCertDoc(derived), false);
  } else {
    writeWithBackup(join(outputDir, EXPOSURE_DOC), generateExposureDoc(derived), false);
    if (derived.nginxEnabled) {
      // starter template only: the dev owns this file, never overwrite silently
      const nginxPath = join(outputDir, "nginx.conf");
      if (!existsSync(nginxPath)) writeFileSync(nginxPath, generateNginxConf(derived), "utf8");
      mkdirSync(join(outputDir, "certs"), { recursive: true });
    }
  }
  mkdirSync(join(outputDir, "assets"), { recursive: true });
  if (derived.usesInternalCa) {
    ensureRootCaPlaceholder(outputDir);
    writeExtractScript(outputDir);
  }

  if (cli.nonInteractive) {
    console.log(`Configuration written to ${outputDir}`);
    console.log(`Enabled profiles: ${derived.composeProfiles}`);
    if (backupPath) console.log(`Backup of the previous .env: ${backupPath}`);
  } else {
    log.success(
      `Configuration written to ${pc.cyan(outputDir)}` +
        (reused.length ? ` (${reused.length} secrets reused)` : ""),
    );
    if (backupPath) log.info(`Backup of the previous .env: ${backupPath}`);
  }

  if (answers.startStack) {
    const runner = makeRunner(outputDir);
    const reporter = createReporter(!cli.nonInteractive && Boolean(process.stdout.isTTY));
    const result = await startStack(derived, runner, reporter, {
      freshDbSecret: generated.includes("DB_USER_PASSWORD"),
    });
    if (!result.ok) {
      console.error(pc.red(result.error ?? "Failed to start the stack"));
      console.error(
        pc.dim(
          `Inspect the stack with: cd ${outputDir} && docker compose ps && docker compose logs --tail 50`,
        ),
      );
      console.log(summary(derived, secrets));
      return 1;
    }
  } else if (!cli.nonInteractive) {
    log.info(`To start the stack: ${pc.cyan(`cd ${outputDir} && docker compose up -d`)}`);
  }

  console.log("");
  console.log(summary(derived, secrets));
  if (!cli.nonInteractive) wizardOutro("Configuration completed 🎉");
  return 0;
}

const code = await main();
process.exit(code);
