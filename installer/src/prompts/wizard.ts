import {
  intro,
  outro,
  text,
  select,
  multiselect,
  confirm,
  isCancel,
  cancel,
  note,
  log,
} from "@clack/prompts";
import pc from "picocolors";
import {
  answersSchema,
  DEFAULT_ANSWERS,
  formatZodError,
  isHostname,
  isIpv4,
  type Answers,
  type AnswersInput,
} from "../config/schema.js";
import { OPTIONAL_PROFILES, OPTIONAL_SERVICES, type OptionalProfile } from "../services.js";
import type { EnvMap } from "../env-file.js";

function abortIfCancelled<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("Installation cancelled.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

const parseBool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface WizardOptions {
  /** values read from an existing .env, used as defaults */
  existingEnv: EnvMap;
  /** true when /var/run/docker.sock is mounted */
  dockerAvailable: boolean;
  outputDir: string;
  /** values already provided via CLI: the related question is skipped */
  preset: Partial<Answers>;
}

export async function runWizard(options: WizardOptions): Promise<Answers> {
  const { existingEnv, dockerAvailable, preset } = options;

  const version = process.env.MYWIZARD_VERSION;
  intro(pc.bgYellow(pc.black(` MyWizard ${version ? `v${version} ` : ""}— MySagra installer `)));

  if (Object.keys(existingEnv).length > 0) {
    log.info(
      `Existing configuration found in ${pc.cyan(options.outputDir + "/.env")}: secrets will be reused.`,
    );
  }

  const setup =
    preset.setup ??
    abortIfCancelled(
      await select({
        message: "Setup type",
        initialValue: existingEnv.SETUP_MODE === "advanced" ? "advanced" : "simple",
        options: [
          {
            value: "simple" as const,
            label: "Simple (recommended)",
            hint: "self-contained stack: Caddy, HTTPS and ready-to-use hostnames",
          },
          {
            value: "advanced" as const,
            label: "Advanced",
            hint: "no proxy, services on host ports: several stacks per machine, you handle the exposure",
          },
        ],
      }),
    );

  const candidate: Partial<AnswersInput> =
    setup === "simple" ? await simpleWizard(options) : await advancedWizard(options);

  const parsed = answersSchema.safeParse({
    ...candidate,
    setup,
    regenerateSecrets: preset.regenerateSecrets ?? false,
    outputDir: options.outputDir,
    startStack: false,
  });
  if (!parsed.success) {
    cancel(`Invalid configuration:\n${formatZodError(parsed.error)}`);
    process.exit(1);
  }
  const answers = parsed.data;

  note(summaryLines(answers).join("\n"), "Summary");

  const ok = abortIfCancelled(
    await confirm({ message: "Generate the configuration files?", initialValue: true }),
  );
  if (!ok) {
    cancel("No file was written.");
    process.exit(0);
  }

  // the stack can only be started once the files exist, so this question comes
  // after the generation is confirmed
  if (preset.startStack !== undefined) {
    answers.startStack = preset.startStack;
  } else if (dockerAvailable) {
    answers.startStack = abortIfCancelled(
      await confirm({ message: "Start the stack now?", initialValue: true }),
    );
  } else {
    log.warn(
      "Docker socket is not mounted: the installer cannot start the stack.\n" +
        "Add -v /var/run/docker.sock:/var/run/docker.sock to enable automatic startup.",
    );
  }

  return answers;
}

function summaryLines(a: Answers): string[] {
  const common = [
    `Services:      ${a.services.length ? a.services.join(", ") : "core only"}`,
    `Project:       ${a.projectName}`,
    `REQUIRE_TABLE: ${a.requireTable}`,
    `SHOW_NUMBERS:  ${a.showNumbers}`,
    `Output:        ${a.outputDir}`,
  ];
  if (a.setup === "advanced") {
    return [
      "Setup:         advanced (no bundled proxy)",
      `Stack name:    ${a.stackName}`,
      `Server:        ${a.serverIp}`,
      `Ports:         ${
        a.publishPorts
          ? `published on the host${a.portOffset ? ` (offset ${a.portOffset})` : ""}`
          : "internal docker network only"
      }`,
      `Connector:     ${
        a.connector === "cloudflare"
          ? "Cloudflare Tunnel"
          : a.connector === "nginx"
            ? "nginx container (config provided by you)"
            : a.connector === "caddy"
              ? `bundled Caddy (*-${a.baseDomain})`
              : "none"
      }`,
      ...(a.externalDomain ? [`External dom.: ${a.externalDomain}`] : []),
      `Trust proxies: ${a.trustProxyLevel}`,
      ...common,
    ];
  }
  const suffix = a.hostPrefix ? `${a.hostPrefix}-${a.baseDomain}` : a.baseDomain;
  return [
    `Setup:         simple (bundled Caddy)`,
    `Mode:          ${a.mode === "lan" ? "local network (Caddy internal CA)" : "public domain (Let's Encrypt)"}`,
    `Server:        ${a.serverIp}`,
    `Access:        ${
      a.dns === "manual"
        ? `*-${suffix} (local DNS / hosts file required)`
        : a.dns === "sslip"
          ? `*-${suffix} (automatic DNS via sslip.io)`
          : `*-${suffix} + direct https://${a.serverIp}`
    }`,
    ...common,
  ];
}

/** Questions shared by both setups. */
async function commonQuestions(options: WizardOptions) {
  const { existingEnv, preset } = options;

  const previousProfiles = existingEnv.COMPOSE_PROFILES?.split(",")
    .map((p) => p.trim())
    .filter((p): p is OptionalProfile => (OPTIONAL_PROFILES as readonly string[]).includes(p));

  const services =
    preset.services ??
    abortIfCancelled(
      await multiselect<OptionalProfile>({
        message: "Optional services to install (space to toggle)",
        required: false,
        initialValues:
          previousProfiles && previousProfiles.length > 0
            ? previousProfiles
            : (DEFAULT_ANSWERS.services as OptionalProfile[]),
        options: OPTIONAL_SERVICES.map((s) => ({
          value: s.profile,
          label: s.label,
          hint: s.description,
        })),
      }),
    );

  const requireTable =
    preset.requireTable ??
    abortIfCancelled(
      await confirm({
        message: "Ask the customer for a table number? (REQUIRE_TABLE)",
        initialValue: parseBool(existingEnv.REQUIRE_TABLE, false),
      }),
    );

  const showNumbers =
    preset.showNumbers ??
    abortIfCancelled(
      await confirm({
        message:
          "Use the sequential order number as the main code instead of the display code? (SHOW_NUMBERS)",
        initialValue: parseBool(existingEnv.SHOW_NUMBERS, false),
      }),
    );

  return { services, requireTable, showNumbers };
}

/** Optional connector: Cloudflare Tunnel, nginx container, or nothing. */
async function askConnector(
  options: WizardOptions,
): Promise<{ connector: "none" | "cloudflare" | "nginx" | "caddy"; cloudflareToken: string }> {
  const { existingEnv, preset } = options;

  const connector =
    preset.connector ??
    abortIfCancelled(
      await select({
        message: "Add a connector to expose the stack?",
        initialValue: (["cloudflare", "nginx", "caddy"].includes(existingEnv.CONNECTOR ?? "")
          ? existingEnv.CONNECTOR
          : "none") as "none" | "cloudflare" | "nginx" | "caddy",
        options: [
          {
            value: "caddy" as const,
            label: "Caddy (standalone, like the simple setup)",
            hint: "bundled reverse proxy with automatic TLS and ready-to-use hostnames",
          },
          {
            value: "cloudflare" as const,
            label: "Cloudflare Tunnel",
            hint: "cloudflared connector, no port to open on the firewall",
          },
          {
            value: "nginx" as const,
            label: "nginx container",
            hint: "container + starter nginx.conf, you own the configuration",
          },
          {
            value: "none" as const,
            label: "Skip (recommended for experts)",
            hint: "no connector: plug your own proxy into the docker network",
          },
        ],
      }),
    );

  let cloudflareToken = preset.cloudflareToken ?? existingEnv.CLOUDFLARE_TUNNEL_TOKEN ?? "";
  if (connector === "cloudflare" && !cloudflareToken) {
    cloudflareToken = abortIfCancelled(
      await text({
        message: "Cloudflare Tunnel token (Zero Trust → Networks → Tunnels)",
        placeholder: "eyJhIjoi…",
        validate: (v) => (v?.trim() ? undefined : "Token required"),
      }),
    ).trim();
  }

  return { connector, cloudflareToken: connector === "cloudflare" ? cloudflareToken : "" };
}

/** Simple setup: as few questions as possible, everything else is defaulted. */
async function simpleWizard(options: WizardOptions): Promise<Partial<AnswersInput>> {
  const { existingEnv, preset } = options;

  const mode =
    preset.mode ??
    abortIfCancelled(
      await select({
        message: "Where does this installation run?",
        initialValue: existingEnv.TLS_MODE === "caddy-acme" ? "public" : "lan",
        options: [
          {
            value: "lan" as const,
            label: "Local network (LAN) (recommended)",
            hint: "certificates from Caddy's internal CA, to be trusted on each device",
          },
          {
            value: "public" as const,
            label: "Public domain",
            hint: "automatic Let's Encrypt certificates",
          },
        ],
      }),
    );

  const serverIp =
    preset.serverIp ??
    abortIfCancelled(
      await text({
        message: "Server IP address (or hostname)",
        placeholder: "192.168.1.100",
        initialValue: existingEnv.SERVER_IP ?? "",
        validate: (v) =>
          !v?.trim()
            ? "This value is required"
            : isIpv4(v.trim()) || isHostname(v.trim())
              ? undefined
              : "Invalid IP address or hostname",
      }),
    ).trim();

  const sslipDomain = `${serverIp.replace(/\./g, "-")}.sslip.io`;

  const dns =
    preset.dns ??
    (mode === "public"
      ? ("manual" as const)
      : abortIfCancelled(
          await select({
            message: "How should devices reach MySagra?",
            initialValue:
              existingEnv.DNS_MODE === "manual"
                ? "manual"
                : existingEnv.DNS_MODE === "sslip"
                  ? "sslip"
                  : "hybrid",
            options: [
              {
                value: "hybrid" as const,
                label: "Hostnames + direct IP (recommended)",
                hint: `cashier-${sslipDomain} and https://${serverIp} — always works`,
              },
              {
                value: "sslip" as const,
                label: "Hostnames only (sslip.io)",
                hint: "no client setup, requires a public DNS resolver",
              },
              {
                value: "manual" as const,
                label: "Custom domain",
                hint: "needs a local DNS entry or a hosts file on every device",
              },
            ],
          }),
        ));

  const hostPrefix = (
    preset.hostPrefix ??
    abortIfCancelled(
      await text({
        message:
          "Instance prefix for the hostnames (press Enter for none, the usual case with a single instance)",
        placeholder: "e.g. sagra1 → cashier-sagra1-<domain>",
        initialValue: existingEnv.HOST_PREFIX ?? "",
        defaultValue: "",
        validate: (v) => {
          const value = (v ?? "").trim();
          if (!value) return undefined;
          return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?$/.test(value)
            ? undefined
            : "Use letters, digits and - only";
        },
      }),
    )
  )
    .trim()
    .toLowerCase();

  let baseDomain = preset.baseDomain;
  if (dns === "manual" && !baseDomain) {
    baseDomain = abortIfCancelled(
      await text({
        message: "Base domain (hostnames will be cashier-<domain>, admin-<domain>, …)",
        placeholder: mode === "lan" ? "mysagra.lan" : "mysagra.it",
        initialValue: existingEnv.BASE_DOMAIN ?? (mode === "lan" ? "mysagra.lan" : ""),
        validate: (v) => {
          const value = v?.trim();
          if (!value) return "This value is required";
          if (!isHostname(value)) return "Invalid domain (e.g. mysagra.lan)";
          if (/\.local$/i.test(value))
            return ".local is reserved for mDNS and often fails: use .lan, .home.arpa or sslip.io";
          return undefined;
        },
      }),
    )
      .trim()
      .toLowerCase();
  }

  const tls = preset.tls ?? (mode === "public" ? "caddy-acme" : "caddy-internal");

  let acmeEmail = preset.acmeEmail ?? existingEnv.ACME_EMAIL;
  if (tls === "caddy-acme" && !acmeEmail) {
    acmeEmail = abortIfCancelled(
      await text({
        message: "Contact email for Let's Encrypt",
        placeholder: "admin@" + (baseDomain ?? "example.com"),
        validate: (v) =>
          /^\S+@\S+\.\S+$/.test(v?.trim() ?? "") ? undefined : "Invalid email address",
      }),
    ).trim();
  }

  const { services, requireTable, showNumbers } = await commonQuestions(options);

  return {
    mode,
    serverIp,
    dns,
    hostPrefix,
    baseDomain,
    tls,
    acmeEmail,
    services,
    requireTable,
    showNumbers,
    nodeEnv: preset.nodeEnv ?? "production",
    projectName: preset.projectName ?? existingEnv.COMPOSE_PROJECT_NAME ?? "mysagra",
    trustProxyLevel: preset.trustProxyLevel ?? 1,
    exposeDb: preset.exposeDb ?? false,
    exposeRedis: preset.exposeRedis ?? false,
  };
}

/** Advanced setup: full control, no bundled proxy, several stacks per machine. */
async function advancedWizard(options: WizardOptions): Promise<Partial<AnswersInput>> {
  const { existingEnv, preset } = options;

  const stackName = (
    preset.stackName ??
    abortIfCancelled(
      await text({
        message: "Stack name (press Enter to generate one)",
        placeholder: "e.g. sagra-paese — used for containers, volumes and the compose project",
        initialValue: existingEnv.STACK_NAME ?? "",
        defaultValue: "",
        validate: (v) => {
          const value = (v ?? "").trim();
          if (!value) return undefined;
          return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?$/.test(value)
            ? undefined
            : "Use letters, digits and - only";
        },
      }),
    )
  )
    .trim()
    .toLowerCase();

  const serverIp =
    preset.serverIp ??
    abortIfCancelled(
      await text({
        message: "Public address of this host (IP or hostname used by browsers)",
        placeholder: "192.168.1.100",
        initialValue: existingEnv.SERVER_IP ?? "",
        validate: (v) =>
          !v?.trim()
            ? "This value is required"
            : isIpv4(v.trim()) || isHostname(v.trim())
              ? undefined
              : "Invalid IP address or hostname",
      }),
    ).trim();

  const publishPorts =
    preset.publishPorts ??
    abortIfCancelled(
      await confirm({
        message:
          "Publish the service ports on the host? (no = services stay on the internal docker network)",
        initialValue: existingEnv.PUBLISH_PORTS === "true",
      }),
    );

  // port offset and external domain are expert-only knobs: the stack talks over
  // the internal docker network and the compose/.env can be tweaked afterwards
  const portOffset = preset.portOffset ?? Number(existingEnv.PORT_OFFSET ?? 0);
  const externalDomain = (preset.externalDomain ?? existingEnv.EXTERNAL_DOMAIN ?? "")
    .trim()
    .toLowerCase();

  const trustProxyLevel = Number(
    abortIfCancelled(
      await text({
        message: "TRUST_PROXY_LEVEL — number of proxies in front of the API (1 for a single proxy)",
        placeholder: "1",
        initialValue: existingEnv.TRUST_PROXY_LEVEL ?? "",
        defaultValue: "1",
        validate: (v) => {
          const value = (v ?? "").trim();
          if (!value) return undefined;
          return /^[0-5]$/.test(value) ? undefined : "Enter a number between 0 and 5";
        },
      }),
    ) || 1,
  );

  const { services, requireTable, showNumbers } = await commonQuestions(options);

  const nodeEnv =
    preset.nodeEnv ??
    abortIfCancelled(
      await select({
        message: "NODE_ENV",
        initialValue: existingEnv.NODE_ENV === "development" ? "development" : "production",
        options: [
          { value: "production" as const, label: "production (recommended)" },
          { value: "development" as const, label: "development" },
        ],
      }),
    );

  const exposeDb =
    preset.exposeDb ??
    abortIfCancelled(
      await confirm({
        message: "Publish the MySQL port (3306 + offset) on the host?",
        initialValue: false,
      }),
    );

  const exposeRedis =
    preset.exposeRedis ??
    abortIfCancelled(
      await confirm({
        message: "Publish the Redis port (6379 + offset) on the host?",
        initialValue: false,
      }),
    );

  const { connector, cloudflareToken } = await askConnector(options);

  return {
    stackName,
    serverIp,
    publishPorts,
    connector,
    cloudflareToken,
    portOffset,
    externalDomain,
    trustProxyLevel,
    services,
    requireTable,
    showNumbers,
    nodeEnv,
    exposeDb,
    exposeRedis,
    projectName: preset.projectName ?? existingEnv.COMPOSE_PROJECT_NAME ?? "mysagra",
    dns: "manual",
    mode: "lan",
    tls: "caddy-internal",
    baseDomain: externalDomain || undefined,
  };
}

export function wizardOutro(message: string): void {
  outro(message);
}
