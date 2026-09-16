import { randomBytes } from "node:crypto";
import { z } from "zod";
import { OPTIONAL_PROFILES } from "../services.js";

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isIpv4 = (value: string): boolean => IPV4_RE.test(value);
export const isHostname = (value: string): boolean => HOSTNAME_RE.test(value);

export const profileSchema = z.enum(OPTIONAL_PROFILES);

export const answersSchema = z
  .object({
    /**
     * - `simple`: self-contained stack with Caddy, TLS and hostnames; one
     *   command, nothing else to configure
     * - `advanced`: no reverse proxy, services published on host ports so that
     *   several stacks coexist behind an existing proxy managed by the dev
     */
    setup: z.enum(["simple", "advanced"]).default("simple"),
    /** advanced setup: stack identifier (empty => generated) */
    stackName: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (v) => v === "" || /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v),
        "Invalid stack name (use letters, digits and -)",
      )
      .default(""),
    /** advanced setup: publish the service ports on the host (off by default) */
    publishPorts: z.boolean().default(false),
    /**
     * Advanced setup: optional connector added to the stack.
     * - `none`: nothing, the dev wires their own proxy
     * - `cloudflare`: cloudflared tunnel connector (needs a token)
     * - `nginx`: an nginx container with a starter config the dev can edit
     * - `caddy`: the same bundled Caddy of the simple setup (TLS + hostnames)
     */
    connector: z.enum(["none", "cloudflare", "nginx", "caddy"]).default("none"),
    /** Cloudflare Tunnel token (required with connector=cloudflare) */
    cloudflareToken: z.string().trim().default(""),
    /** advanced setup: offset added to every published host port */
    portOffset: z.coerce.number().int().min(0).max(40000).default(0),
    /** advanced setup: public domain served by the external proxy (optional) */
    externalDomain: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === "" || isHostname(v), "Invalid domain")
      .default(""),
    /** number of proxies in front of the backend (X-Forwarded-For depth) */
    trustProxyLevel: z.coerce.number().int().min(0).max(5).default(1),
    /** `lan` = local network with Caddy internal CA, `public` = public domain with ACME */
    mode: z.enum(["lan", "public"]).default("lan"),
    /** IP address (or hostname) of the server running the stack */
    serverIp: z
      .string()
      .trim()
      .min(1, "Server address is required")
      .refine((v) => isIpv4(v) || isHostname(v), "Invalid IP address or hostname"),
    /**
     * How devices reach the services:
     * - `hybrid` (default): sslip.io hostnames **and** direct `https://<ip>:<port>`
     *   access, so everything works even without DNS
     * - `sslip`: wildcard DNS only (`<name>-192-168-1-10.sslip.io`)
     * - `manual`: custom domain, resolved via local DNS or hosts file
     */
    dns: z.enum(["hybrid", "sslip", "manual"]).default("hybrid"),
    /**
     * Optional instance prefix: hostnames become `<service>-<prefix>-<domain>`,
     * useful when several MySagra instances share the same network/domain.
     */
    hostPrefix: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (v) => v === "" || /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v),
        "Invalid prefix (use letters, digits and -)",
      )
      .default(""),
    /** base domain: hostnames become <service>-<baseDomain> (required with dns=manual) */
    baseDomain: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === "" || isHostname(v), "Invalid base domain (e.g. mysagra.lan)")
      .optional(),
    /** TLS strategy handled by Caddy */
    tls: z.enum(["caddy-internal", "caddy-acme"]).default("caddy-internal"),
    /** ACME contact email (required with tls=caddy-acme) */
    acmeEmail: z.string().trim().email("Invalid email address").optional(),
    /** enabled optional profiles */
    services: z.array(profileSchema).default([...OPTIONAL_PROFILES]),
    /** ask the customer for a table number */
    requireTable: z.boolean().default(false),
    /** show the sequential order number instead of the display code */
    showNumbers: z.boolean().default(false),
    /** NODE_ENV for the services */
    nodeEnv: z.enum(["production", "development"]).default("production"),
    /** start the stack once the configuration is written */
    startStack: z.boolean().default(false),
    /** publish the MySQL port on the host (not recommended) */
    exposeDb: z.boolean().default(false),
    /** publish the Redis port on the host (not recommended) */
    exposeRedis: z.boolean().default(false),
    /** regenerate every secret even if present in an existing .env */
    regenerateSecrets: z.boolean().default(false),
    /** docker compose project name (prefix of containers and volumes) */
    projectName: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "Invalid project name (use a-z, 0-9, - and _)")
      .default("mysagra"),
    /** output directory (defaults to /out inside the container) */
    outputDir: z.string().min(1).default("/out"),
  })
  .superRefine((data, ctx) => {
    if (data.setup === "simple" && data.dns === "manual" && !data.baseDomain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseDomain"],
        message: "A base domain is required when DNS is handled manually",
      });
    }
    const needsIpForSslip =
      (data.setup === "simple" && data.dns !== "manual") ||
      (data.setup === "advanced" && data.connector === "caddy" && !data.externalDomain);
    if (needsIpForSslip && !isIpv4(data.serverIp)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverIp"],
        message: "Automatic sslip.io DNS requires an IPv4 address (use --dns manual otherwise)",
      });
    }
    if (data.dns === "hybrid" && data.tls === "caddy-acme") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dns"],
        message: "Direct IP access cannot use Let's Encrypt: pick --dns manual for public domains",
      });
    }
    if (data.connector === "cloudflare" && !data.cloudflareToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloudflareToken"],
        message: "The Cloudflare Tunnel connector requires a token",
      });
    }
    if (data.tls === "caddy-acme" && !data.acmeEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acmeEmail"],
        message: "ACME TLS (Let's Encrypt) requires a contact email",
      });
    }
    if (data.tls === "caddy-acme" && data.dns !== "manual") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dns"],
        message: "Let's Encrypt requires a real domain: use --dns manual with your own domain",
      });
    }
    if (data.tls === "caddy-acme" && data.baseDomain && isIpv4(data.baseDomain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseDomain"],
        message: "ACME requires a real domain, not an IP address",
      });
    }
  })
  .transform((data) => {
    // advanced setup: the stack name identifies containers, volumes and hostnames
    const stackName =
      data.setup === "advanced"
        ? data.stackName || `mysagra-${randomBytes(3).toString("hex")}`
        : data.stackName;

    const hostPrefix = data.setup === "advanced" ? "" : data.hostPrefix;

    const projectName =
      data.setup === "advanced"
        ? data.projectName === "mysagra"
          ? stackName
          : data.projectName
        : data.projectName === "mysagra" && hostPrefix
          ? `mysagra-${hostPrefix}`
          : data.projectName;

    const sslip = `${data.serverIp.replace(/\./g, "-")}.sslip.io`;
    const baseDomain =
      data.setup === "advanced"
        ? data.connector === "caddy"
          ? data.externalDomain || sslip
          : data.externalDomain
        : data.dns === "manual"
          ? data.baseDomain!
          : // sslip.io resolves <anything>-1-2-3-4.sslip.io to 1.2.3.4
            sslip;

    // advanced + bundled Caddy: hostnames come from sslip.io unless a domain is given
    const dns =
      data.setup === "advanced" && data.connector === "caddy"
        ? data.externalDomain
          ? ("manual" as const)
          : ("hybrid" as const)
        : data.dns;

    return { ...data, stackName, hostPrefix, projectName, baseDomain, dns };
  });

export type Answers = z.output<typeof answersSchema>;
export type AnswersInput = z.input<typeof answersSchema>;

/** Defaults shared by the wizard and the non-interactive mode. */
export const DEFAULT_ANSWERS: Partial<AnswersInput> = {
  mode: "lan",
  dns: "hybrid",
  tls: "caddy-internal",
  services: [...OPTIONAL_PROFILES].filter((p) => p !== "dbgate"),
  requireTable: false,
  showNumbers: false,
  nodeEnv: "production",
  startStack: false,
  exposeDb: false,
  exposeRedis: false,
  regenerateSecrets: false,
  setup: "simple",
  stackName: "",
  publishPorts: false,
  connector: "none",
  cloudflareToken: "",
  portOffset: 0,
  externalDomain: "",
  trustProxyLevel: 1,
  hostPrefix: "",
  projectName: "mysagra",
  outputDir: "/out",
};

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `  • ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
    .join("\n");
}
