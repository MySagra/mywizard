/**
 * Catalog of the MySagra stack services.
 *
 * Core services (backend, db, redis) have no profile and are always enabled.
 * The Caddy reverse proxy uses the `proxy` profile, enabled by default.
 * Every other service is optional and gets enabled through a compose profile
 * (`COMPOSE_PROFILES` in the generated .env file).
 */

export const OPTIONAL_PROFILES = [
  "mycassa",
  "myadmin",
  "mystampa",
  "mynumeri",
  "myclienti",
  "dbgate",
] as const;

export type OptionalProfile = (typeof OPTIONAL_PROFILES)[number];

export type ProfileId = OptionalProfile | "proxy";

export interface ServiceDef {
  /** service key inside docker-compose */
  id: string;
  /** human readable name shown in the wizard and summaries */
  label: string;
  /** short description shown in the wizard */
  description: string;
  /** compose profile; missing => core service, always enabled */
  profile?: ProfileId;
  /** internal port exposed on the docker network */
  port?: number;
  /** subdomain prefix behind Caddy (e.g. `cashier` => cashier-<base>) */
  subdomain?: string;
  /** the service mounts rootCA.pem and uses NODE_EXTRA_CA_CERTS */
  needsRootCa?: boolean;
  /** the service is reachable through the reverse proxy */
  proxied?: boolean;
  /** host port used for direct IP access (hybrid DNS mode, simple setup) */
  ipPort?: number;
  /** default host port published in advanced setup (no reverse proxy) */
  hostPort?: number;
  /** selected by default in the wizard */
  defaultEnabled?: boolean;
}

export const SERVICES: readonly ServiceDef[] = [
  {
    id: "mysagra-backend",
    label: "MySagra API",
    description: "REST + SSE backend (core)",
    port: 4300,
    subdomain: "api",
    proxied: true,
    hostPort: 4300,
    ipPort: 4443,
  },
  {
    id: "db",
    label: "MySQL",
    description: "MySQL database (core)",
    port: 3306,
  },
  {
    id: "redis",
    label: "Redis",
    description: "Cache / pub-sub used by the backend (core)",
    port: 6379,
  },
  {
    id: "caddy",
    label: "Caddy",
    description: "Reverse proxy with automatic TLS",
    profile: "proxy",
    port: 443,
  },
  {
    id: "mycassa",
    label: "MyCassa",
    description: "Cash register UI",
    profile: "mycassa",
    port: 3031,
    subdomain: "cashier",
    needsRootCa: true,
    proxied: true,
    hostPort: 3031,
    ipPort: 443,
    defaultEnabled: true,
  },
  {
    id: "myamministratore",
    label: "MyAmministratore",
    description: "Admin panel",
    profile: "myadmin",
    port: 3000,
    subdomain: "admin",
    needsRootCa: true,
    proxied: true,
    hostPort: 3035,
    ipPort: 8443,
    defaultEnabled: true,
  },
  {
    id: "mystampa",
    label: "MyStampa",
    description: "Order ticket printing service",
    profile: "mystampa",
    port: 3032,
    subdomain: "print",
    proxied: true,
    hostPort: 3032,
    ipPort: 8444,
    defaultEnabled: true,
  },
  {
    id: "mynumeri",
    label: "MyNumeri",
    description: "Ready order numbers display",
    profile: "mynumeri",
    port: 3033,
    subdomain: "numbers",
    needsRootCa: true,
    proxied: true,
    hostPort: 3033,
    ipPort: 8445,
    defaultEnabled: true,
  },
  {
    id: "myclienti",
    label: "MyClienti",
    description: "Customer ordering web app",
    profile: "myclienti",
    port: 3034,
    subdomain: "clienti",
    needsRootCa: true,
    proxied: true,
    hostPort: 3034,
    ipPort: 8446,
    defaultEnabled: true,
  },
  {
    id: "dbgate",
    label: "DBGate",
    description: "Web database client (optional)",
    profile: "dbgate",
    port: 3000,
    subdomain: "db",
    proxied: true,
    hostPort: 3036,
    ipPort: 8447,
    defaultEnabled: false,
  },
] as const;

export const SERVICE_BY_ID = new Map(SERVICES.map((s) => [s.id, s]));

export const OPTIONAL_SERVICES = SERVICES.filter(
  (s): s is ServiceDef & { profile: OptionalProfile } =>
    s.profile !== undefined && s.profile !== "proxy",
);

export const CORE_SERVICES = SERVICES.filter((s) => s.profile === undefined);

export function serviceByProfile(profile: OptionalProfile): ServiceDef {
  const svc = OPTIONAL_SERVICES.find((s) => s.profile === profile);
  if (!svc) throw new Error(`Unknown profile: ${profile}`);
  return svc;
}

/** Enabled services (core + proxy + selected profiles), in catalog order. */
export function enabledServices(profiles: readonly OptionalProfile[], proxy = true): ServiceDef[] {
  const set = new Set<string>(profiles);
  return SERVICES.filter((s) => {
    if (s.profile === undefined) return true;
    if (s.profile === "proxy") return proxy;
    return set.has(s.profile);
  });
}

/**
 * Public hostname of the service behind the proxy:
 * `<service>-<base domain>` or `<service>-<instance prefix>-<base domain>`
 * when several MySagra instances share the same base domain.
 */
export function hostFor(
  service: ServiceDef,
  baseDomain: string,
  instancePrefix?: string,
): string | undefined {
  if (!service.subdomain) return undefined;
  const parts = [service.subdomain, instancePrefix, baseDomain].filter(Boolean);
  return parts.join("-");
}
