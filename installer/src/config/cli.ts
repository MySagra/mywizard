import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import {
  answersSchema,
  DEFAULT_ANSWERS,
  formatZodError,
  type Answers,
  type AnswersInput,
} from "./schema.js";
import { OPTIONAL_PROFILES, type OptionalProfile } from "../services.js";
import { readEnvFile, type EnvMap } from "../env-file.js";

export interface CliResult {
  /** values explicitly provided via CLI flags or config file */
  preset: Partial<AnswersInput>;
  nonInteractive: boolean;
  outputDir: string;
  help: boolean;
  version: boolean;
  regenerateSecrets: boolean;
  /** true when --start/--no-start was passed explicitly */
  startExplicit: boolean;
}

export const HELP_TEXT = `
mywizard — MySagra stack configurator

USAGE
  docker run --rm -it \\
    -v "$PWD":/out \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    ghcr.io/mysagra/mywizard [options]

OPTIONS
  -o, --out <dir>            Output directory (default: /out)
      --non-interactive      No questions: use flags/config/existing .env
      --config <file.json>   JSON file holding the answers

  Setup type
      --setup <simple|advanced>
                             simple (default): self-contained stack with Caddy,
                             TLS and hostnames; advanced: no proxy, services on
                             host ports so several stacks coexist
      --stack-name <name>    Advanced: stack identifier (blank => generated)
      --publish-ports        Advanced: publish the service ports on the host
      --connector <none|cloudflare|nginx|caddy>
                             Advanced: connector added to the stack (default none)
      --cloudflare-token <t> Token used by the cloudflare connector
      --port-offset <n>      Advanced: offset added to every published port
      --external-domain <d>  Advanced: domain served by your own proxy
      --trust-proxy-level <n>
                             Advanced: number of proxies in front of the API

  Simple setup
      --mode <lan|public>    Installation type (default: lan)
      --server-ip <ip>       Server IP address or hostname
      --dns <hybrid|sslip|manual>
                             hybrid (default): hostnames + direct IP access;
                             sslip: hostnames only; manual: your own domain
      --host-prefix <name>   Instance prefix: hosts become cashier-<prefix>-<dom>
                             (empty by default; also prefixes the compose project)
      --base-domain <dom>    Base domain with --dns manual (hosts: cashier-<dom>, ...)
      --tls <caddy-internal|caddy-acme>
      --acme-email <email>   Let's Encrypt email (with --tls caddy-acme)
      --services <list>      Comma separated profiles: ${OPTIONAL_PROFILES.join(",")}
                             ("all" and "none" are accepted)
      --require-table[=bool] Ask the customer for a table number (REQUIRE_TABLE)
      --show-numbers[=bool]  Sequential order number as main code (SHOW_NUMBERS)
      --project <name>       Docker compose project name (default: mysagra)
      --node-env <env>       production | development
      --expose-db            Publish the MySQL port on the host
      --expose-redis         Publish the Redis port on the host
      --start / --no-start   Start (or not) the stack when done
      --regenerate-secrets   Regenerate secrets even if already in the .env
  -h, --help                 Show this message
  -v, --version              Show the version

NON-INTERACTIVE EXAMPLE
  docker run --rm -v "$PWD":/out ghcr.io/mysagra/mywizard \\
    --non-interactive --mode lan --server-ip 192.168.1.100 \\
    --services mycassa,myadmin,mystampa,mynumeri,myclienti \\
    --require-table --no-show-numbers
`;

function parseBoolFlag(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const v = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseServices(value: string): OptionalProfile[] {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all") return [...OPTIONAL_PROFILES];
  if (trimmed === "none" || trimmed === "") return [];
  const parts = trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const invalid = parts.filter((p) => !(OPTIONAL_PROFILES as readonly string[]).includes(p));
  if (invalid.length) {
    throw new Error(
      `Invalid profiles: ${invalid.join(", ")} (valid: ${OPTIONAL_PROFILES.join(", ")})`,
    );
  }
  return parts as OptionalProfile[];
}

/** Boolean flags also accepted without a value (`--require-table` => `--require-table=true`). */
const BOOLEANISH = new Set(["--require-table", "--show-numbers"]);

function normalizeArgv(argv: string[]): string[] {
  return argv.map((arg) => (BOOLEANISH.has(arg) ? `${arg}=true` : arg));
}

export function parseCli(rawArgv: string[]): CliResult {
  const argv = normalizeArgv(rawArgv);
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      out: { type: "string", short: "o" },
      "non-interactive": { type: "boolean" },
      config: { type: "string" },
      setup: { type: "string" },
      "stack-name": { type: "string" },
      "publish-ports": { type: "boolean" },
      connector: { type: "string" },
      "cloudflare-token": { type: "string" },
      "port-offset": { type: "string" },
      "external-domain": { type: "string" },
      "trust-proxy-level": { type: "string" },
      mode: { type: "string" },
      "server-ip": { type: "string" },
      dns: { type: "string" },
      "host-prefix": { type: "string" },
      "base-domain": { type: "string" },
      tls: { type: "string" },
      "acme-email": { type: "string" },
      services: { type: "string" },
      "require-table": { type: "string" },
      "no-require-table": { type: "boolean" },
      "show-numbers": { type: "string" },
      "no-show-numbers": { type: "boolean" },
      project: { type: "string" },
      "node-env": { type: "string" },
      "expose-db": { type: "boolean" },
      "expose-redis": { type: "boolean" },
      start: { type: "boolean" },
      "no-start": { type: "boolean" },
      "regenerate-secrets": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  const preset: Partial<AnswersInput> = {};

  if (values.config) {
    if (!existsSync(values.config)) throw new Error(`Config file not found: ${values.config}`);
    const parsed = JSON.parse(readFileSync(values.config, "utf8")) as Partial<AnswersInput>;
    Object.assign(preset, parsed);
  }

  if (values.setup) preset.setup = values.setup as AnswersInput["setup"];
  if (values["stack-name"] !== undefined) preset.stackName = values["stack-name"];
  if (values["publish-ports"]) preset.publishPorts = true;
  if (values.connector) preset.connector = values.connector as AnswersInput["connector"];
  if (values["cloudflare-token"] !== undefined) {
    preset.cloudflareToken = values["cloudflare-token"];
    if (!values.connector && values["cloudflare-token"]) preset.connector = "cloudflare";
  }
  if (values["port-offset"]) preset.portOffset = Number(values["port-offset"]);
  if (values["external-domain"] !== undefined) preset.externalDomain = values["external-domain"];
  if (values["trust-proxy-level"]) preset.trustProxyLevel = Number(values["trust-proxy-level"]);
  if (values.mode) preset.mode = values.mode as AnswersInput["mode"];
  if (values["server-ip"]) preset.serverIp = values["server-ip"];
  if (values.dns) preset.dns = values.dns as AnswersInput["dns"];
  if (values["host-prefix"] !== undefined) preset.hostPrefix = values["host-prefix"];
  if (values["base-domain"]) {
    preset.baseDomain = values["base-domain"];
    if (!values.dns) preset.dns = "manual";
  }
  if (values.tls) preset.tls = values.tls as AnswersInput["tls"];
  if (values["acme-email"]) preset.acmeEmail = values["acme-email"];
  if (values.services !== undefined) preset.services = parseServices(values.services);
  if (values.project) preset.projectName = values.project;
  if (values["node-env"]) preset.nodeEnv = values["node-env"] as AnswersInput["nodeEnv"];

  // boolean flags: --require-table, --require-table=false, --no-require-table
  const requireTable = values["no-require-table"] ? false : parseBoolFlag(values["require-table"]);
  if (requireTable !== undefined) preset.requireTable = requireTable;

  const showNumbers = values["no-show-numbers"] ? false : parseBoolFlag(values["show-numbers"]);
  if (showNumbers !== undefined) preset.showNumbers = showNumbers;

  if (values["expose-db"]) preset.exposeDb = true;
  if (values["expose-redis"]) preset.exposeRedis = true;

  const startExplicit = Boolean(values.start || values["no-start"]);
  if (values["no-start"]) preset.startStack = false;
  else if (values.start) preset.startStack = true;

  const outputDir = values.out ?? preset.outputDir ?? "/out";
  preset.outputDir = outputDir;

  return {
    preset,
    nonInteractive: Boolean(values["non-interactive"]),
    outputDir,
    help: Boolean(values.help),
    version: Boolean(values.version),
    regenerateSecrets: Boolean(values["regenerate-secrets"]),
    startExplicit,
  };
}

/** Derives defaults from the configuration already present in the output directory. */
export function presetFromEnv(env: EnvMap): Partial<AnswersInput> {
  const preset: Partial<AnswersInput> = {};
  if (env.SERVER_IP) preset.serverIp = env.SERVER_IP;
  if (env.DNS_MODE === "hybrid" || env.DNS_MODE === "sslip" || env.DNS_MODE === "manual")
    preset.dns = env.DNS_MODE;
  if (env.HOST_PREFIX !== undefined) preset.hostPrefix = env.HOST_PREFIX;
  if (env.BASE_DOMAIN && env.DNS_MODE !== "sslip") preset.baseDomain = env.BASE_DOMAIN;
  if (env.TLS_MODE === "caddy-acme" || env.TLS_MODE === "caddy-internal") {
    preset.tls = env.TLS_MODE;
    preset.mode = env.TLS_MODE === "caddy-acme" ? "public" : "lan";
  }
  if (env.ACME_EMAIL) preset.acmeEmail = env.ACME_EMAIL;
  if (env.SETUP_MODE === "simple" || env.SETUP_MODE === "advanced") preset.setup = env.SETUP_MODE;
  if (env.STACK_NAME) preset.stackName = env.STACK_NAME;
  if (env.PORT_OFFSET) preset.portOffset = Number(env.PORT_OFFSET);
  if (env.CLOUDFLARE_TUNNEL_TOKEN) preset.cloudflareToken = env.CLOUDFLARE_TUNNEL_TOKEN;
  if (["none", "cloudflare", "nginx", "caddy"].includes(env.CONNECTOR ?? ""))
    preset.connector = env.CONNECTOR as AnswersInput["connector"];
  if (env.PUBLISH_PORTS) preset.publishPorts = env.PUBLISH_PORTS === "true";
  if (env.EXTERNAL_DOMAIN) preset.externalDomain = env.EXTERNAL_DOMAIN;
  if (env.TRUST_PROXY_LEVEL) preset.trustProxyLevel = Number(env.TRUST_PROXY_LEVEL);
  if (env.COMPOSE_PROJECT_NAME) preset.projectName = env.COMPOSE_PROJECT_NAME;
  if (env.COMPOSE_PROFILES) {
    const profiles = env.COMPOSE_PROFILES.split(",")
      .map((p) => p.trim())
      .filter((p): p is OptionalProfile => (OPTIONAL_PROFILES as readonly string[]).includes(p));
    preset.services = profiles;
  }
  if (env.REQUIRE_TABLE) preset.requireTable = env.REQUIRE_TABLE === "true";
  if (env.SHOW_NUMBERS) preset.showNumbers = env.SHOW_NUMBERS === "true";
  if (env.NODE_ENV === "production" || env.NODE_ENV === "development")
    preset.nodeEnv = env.NODE_ENV;
  return preset;
}

/** Resolves the answers without interaction: defaults ← existing .env ← config/flags. */
export function resolveNonInteractive(cli: CliResult, envPath: string): { answers: Answers } {
  const existing = readEnvFile(envPath);
  const merged: AnswersInput = {
    ...(DEFAULT_ANSWERS as AnswersInput),
    ...presetFromEnv(existing),
    ...cli.preset,
    outputDir: cli.outputDir,
    regenerateSecrets: cli.regenerateSecrets,
  };

  if (merged.mode === "public" && !cli.preset.tls && !existing.TLS_MODE) {
    merged.tls = "caddy-acme";
  }

  const parsed = answersSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration (non-interactive mode):\n${formatZodError(parsed.error)}`,
    );
  }
  return { answers: parsed.data };
}
