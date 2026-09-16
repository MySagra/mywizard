import type { Answers } from "./config/schema.js";
import { enabledServices, hostFor, type ServiceDef } from "./services.js";

export interface ServiceEndpoint {
  service: ServiceDef;
  /** public hostname (simple setup) or `<ip>:<port>` (advanced setup) */
  host: string;
  /** url the user/browser should open */
  url: string;
  /** direct `https://<ip>:<port>` url (simple setup, hybrid mode only) */
  ipUrl?: string;
  /** host port published by the service (advanced setup only) */
  hostPort?: number;
}

export interface DerivedConfig {
  answers: Answers;
  scheme: "http" | "https";
  /** the stack ships its own Caddy reverse proxy */
  proxyEnabled: boolean;
  /** all enabled services (core + proxy + selected profiles) */
  services: ServiceDef[];
  /** services exposed to the users, with host/url */
  endpoints: ServiceEndpoint[];
  /** backend endpoint (always present) */
  api: ServiceEndpoint;
  /** internal URL of the API, used by the other containers */
  internalApiUrl: string;
  /** value of COMPOSE_PROFILES */
  composeProfiles: string;
  /** origins accepted by the backend */
  allowedOrigins: string;
  /** ready-to-paste hosts file entries (simple setup, manual DNS) */
  hostsEntries: string[];
  /** containers mount rootCA.pem */
  usesInternalCa: boolean;
  /** services are also reachable directly on the server IP */
  hasIpAccess: boolean;
  /** extra host ports Caddy must publish for direct IP access */
  ipPorts: number[];
  /** the Cloudflare Tunnel connector is part of the stack */
  cloudflareEnabled: boolean;
  /** an nginx container is part of the stack (config provided by the dev) */
  nginxEnabled: boolean;
}

export function derive(answers: Answers): DerivedConfig {
  const advanced = answers.setup === "advanced";
  // the bundled Caddy can also be picked as connector in the advanced setup
  const proxyEnabled = !advanced || answers.connector === "caddy";
  const services = enabledServices(answers.services, proxyEnabled);

  // advanced setup: no TLS termination here, the external proxy handles it
  const scheme: "http" | "https" =
    advanced && !proxyEnabled && !answers.externalDomain ? "http" : "https";
  const hasIpAccess = proxyEnabled && answers.dns === "hybrid";

  const endpoints: ServiceEndpoint[] = services
    .filter((s) => s.proxied)
    .map((service) => {
      if (advanced && !proxyEnabled) {
        const hostPort = answers.publishPorts
          ? (service.hostPort ?? 0) + answers.portOffset
          : undefined;
        if (answers.externalDomain) {
          const host = hostFor(service, answers.externalDomain)!;
          return { service, host, url: `https://${host}`, hostPort };
        }
        if (hostPort) {
          const host = `${answers.serverIp}:${hostPort}`;
          return { service, host, url: `http://${host}`, hostPort };
        }
        // internal only: the external proxy joins the docker network
        const host = `${service.id}:${service.port}`;
        return { service, host, url: `http://${host}` };
      }
      const host = hostFor(service, answers.baseDomain, answers.hostPrefix)!;
      const endpoint: ServiceEndpoint = { service, host, url: `https://${host}` };
      if (hasIpAccess && service.ipPort) {
        endpoint.ipUrl =
          service.ipPort === 443
            ? `https://${answers.serverIp}`
            : `https://${answers.serverIp}:${service.ipPort}`;
      }
      return endpoint;
    });

  const api = endpoints.find((e) => e.service.id === "mysagra-backend");
  if (!api) throw new Error("Cannot derive the backend endpoint");

  const cloudflareEnabled = answers.connector === "cloudflare";
  const nginxEnabled = answers.connector === "nginx";

  const composeProfiles = [
    ...(proxyEnabled ? ["proxy"] : []),
    ...answers.services,
    ...(cloudflareEnabled ? ["cloudflared"] : []),
    ...(nginxEnabled ? ["nginx"] : []),
  ].join(",");

  const allowedOrigins = endpoints
    .filter((e) => e.service.id !== "mysagra-backend")
    .flatMap((e) => (e.ipUrl ? [e.url, e.ipUrl] : [e.url]))
    .join(",");

  const hostsEntries =
    proxyEnabled && answers.mode === "lan"
      ? endpoints.map((e) => `${answers.serverIp}\t${e.host}`)
      : [];

  return {
    answers,
    scheme,
    proxyEnabled,
    services,
    endpoints,
    api,
    internalApiUrl: "http://mysagra-backend:4300",
    composeProfiles,
    allowedOrigins,
    hostsEntries,
    usesInternalCa: proxyEnabled && answers.tls === "caddy-internal",
    hasIpAccess,
    cloudflareEnabled,
    nginxEnabled,
    ipPorts: hasIpAccess
      ? endpoints.flatMap((e) => (e.service.ipPort ? [e.service.ipPort] : []))
      : [],
  };
}

export function endpointFor(
  derived: DerivedConfig,
  serviceId: string,
): ServiceEndpoint | undefined {
  return derived.endpoints.find((e) => e.service.id === serviceId);
}
