import { stringify } from "yaml";
import type { DerivedConfig } from "../derive.js";
import { SERVICE_BY_ID } from "../services.js";

type ComposeService = Record<string, unknown>;

const LOGGING = {
  driver: "json-file",
  options: { "max-size": "10m", "max-file": "3" },
};

const HARDENING = {
  security_opt: ["no-new-privileges:true"],
  cap_drop: ["ALL"],
};

/**
 * Container name prefixed with the compose project, so that several stacks can
 * coexist on the same host while keeping readable names.
 */
const containerName = (suffix: string) => `\${COMPOSE_PROJECT_NAME:-mysagra}-${suffix}`;

function healthyDep(...services: string[]): Record<string, unknown> {
  return Object.fromEntries(services.map((s) => [s, { condition: "service_healthy" }]));
}

export function generateCompose(derived: DerivedConfig): string {
  const { answers, usesInternalCa } = derived;
  const enabled = new Set(derived.services.map((s) => s.id));
  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, unknown> = {};

  /** Published host ports: only in advanced setup (no bundled reverse proxy). */
  const publish = (serviceId: string): { ports?: string[] } => {
    const endpoint = derived.endpoints.find((e) => e.service.id === serviceId);
    if (derived.proxyEnabled || !endpoint?.hostPort) return {};
    return { ports: [`${endpoint.hostPort}:${endpoint.service.port}`] };
  };

  // in advanced setup every published port is shifted by the offset
  const offset = derived.proxyEnabled ? 0 : answers.portOffset;

  const rootCaMount = usesInternalCa ? ["./rootCA.pem:/app/rootCA.pem:ro"] : [];
  const rootCaEnv = usesInternalCa ? ["NODE_EXTRA_CA_CERTS=/app/rootCA.pem"] : [];

  // ── Core ────────────────────────────────────────────────────────────────
  services.db = {
    image: "mysql:8.4",
    container_name: containerName("db"),
    env_file: [".env"],
    environment: {
      MYSQL_ROOT_PASSWORD: "${ROOT_PASSWORD}",
      MYSQL_DATABASE: "${MYSQL_DATABASE:-mysagra}",
      MYSQL_USER: "${DB_USER:-mysagra}",
      MYSQL_PASSWORD: "${DB_USER_PASSWORD}",
    },
    volumes: ["mysql_data:/var/lib/mysql:delegated"],
    healthcheck: {
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
    ...(answers.exposeDb ? { ports: [`${3306 + offset}:3306`] } : {}),
    restart: "always",
    user: "mysql",
    cap_drop: ["ALL"],
    cap_add: ["CHOWN", "SETGID", "SETUID", "DAC_OVERRIDE"],
    security_opt: ["seccomp=unconfined"],
    logging: LOGGING,
    networks: ["mysagra-network"],
  };
  volumes.mysql_data = { driver: "local" };

  services.redis = {
    image: "redis:7-alpine",
    container_name: containerName("redis"),
    env_file: [".env"],
    command: ["redis-server", "--requirepass", "${REDIS_PASS}", "--appendonly", "yes"],
    volumes: ["redis_data:/data"],
    healthcheck: {
      test: ["CMD-SHELL", 'redis-cli -a "$$REDIS_PASS" ping | grep -q PONG'],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
    ...(answers.exposeRedis ? { ports: [`${6379 + offset}:6379`] } : {}),
    restart: "always",
    security_opt: ["no-new-privileges:true"],
    cap_drop: ["ALL"],
    // the redis entrypoint fixes /data ownership and drops privileges with setpriv
    cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
    logging: LOGGING,
    networks: ["mysagra-network"],
  };
  volumes.redis_data = { driver: "local" };

  services["mysagra-backend"] = {
    image: "ghcr.io/mysagra/mysagra-backend:latest",
    container_name: containerName("api"),
    env_file: [".env"],
    environment: [
      "NODE_ENV=${NODE_ENV:-production}",
      "DATABASE_URL=${DATABASE_URL}",
      "REDIS_URL=${REDIS_URL}",
      "JWT_SECRET=${JWT_SECRET}",
      "PEPPER=${PEPPER}",
      "ALLOWED_ORIGINS=${ALLOWED_ORIGINS}",
      "MIGRATE_ON_START=true",
      "TRUST_PROXY_LEVEL=${TRUST_PROXY_LEVEL:-1}",
      "API_URL=${API_URL}",
      "REQUIRE_TABLE=${REQUIRE_TABLE}",
      "SHOW_NUMBERS=${SHOW_NUMBERS}",
    ],
    depends_on: healthyDep("db", "redis"),
    restart: "always",
    ...publish("mysagra-backend"),
    healthcheck: {
      test: [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://localhost:4300/health",
      ],
      interval: "30s",
      timeout: "3s",
      retries: 3,
    },
    volumes: ["api_logs:/app/logs", "api_public:/app/public"],
    tmpfs: ["/tmp", "/run"],
    ...HARDENING,
    cap_add: ["NET_BIND_SERVICE"],
    logging: LOGGING,
    networks: ["mysagra-network"],
  };
  volumes.api_logs = { driver: "local" };
  volumes.api_public = { driver: "local" };

  if (derived.proxyEnabled) {
    // ── Reverse proxy (simple setup only) ───────────────────────────────────────────────────────
    services.caddy = {
      image: "caddy:2-alpine",
      container_name: containerName("caddy"),
      profiles: ["proxy"],
      restart: "always",
      env_file: [".env"],
      ports: [
        "80:80",
        "443:443",
        "443:443/udp",
        // direct https://<ip>:<port> access (hybrid mode)
        ...derived.ipPorts.filter((p) => p !== 443).flatMap((p) => [`${p}:${p}`, `${p}:${p}/udp`]),
      ],
      volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config"],
      healthcheck: {
        test: ["CMD", "caddy", "version"],
        interval: "30s",
        timeout: "5s",
        retries: 3,
      },
      logging: LOGGING,
      // public hostnames resolve to Caddy from inside the network too, so that
      // server-side calls between services use the same URLs as the browser
      networks: {
        "mysagra-network": { aliases: derived.endpoints.map((e) => e.host) },
      },
    };
    volumes.caddy_data = { driver: "local" };
    volumes.caddy_config = { driver: "local" };
  }

  // ── Optional services ───────────────────────────────────────────────────
  if (enabled.has("mycassa")) {
    services.mycassa = {
      image: "ghcr.io/mysagra/mysagra-mycassa:latest",
      container_name: containerName("mycassa"),
      profiles: [SERVICE_BY_ID.get("mycassa")!.profile!],
      restart: "always",
      ...publish("mycassa"),
      env_file: [".env"],
      environment: [
        "NODE_ENV=${NODE_ENV:-production}",
        "AUTH_URL=${AUTH_URL_CASSA}",
        "REQUIRE_TABLE=${REQUIRE_TABLE}",
        "SHOW_NUMBERS=${SHOW_NUMBERS}",
        ...rootCaEnv,
      ],
      depends_on: healthyDep("mysagra-backend"),
      ...(rootCaMount.length ? { volumes: rootCaMount } : {}),
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
  }

  if (enabled.has("myamministratore")) {
    services.myamministratore = {
      image: "ghcr.io/mysagra/mysagra-myamministratore:latest",
      container_name: containerName("myamministratore"),
      profiles: [SERVICE_BY_ID.get("myamministratore")!.profile!],
      restart: "always",
      ...publish("myamministratore"),
      env_file: [".env"],
      environment: [
        "NODE_ENV=${NODE_ENV:-production}",
        "AUTH_URL=${AUTH_URL_AMMINISTRATORE}",
        ...rootCaEnv,
      ],
      depends_on: healthyDep("mysagra-backend"),
      ...(rootCaMount.length ? { volumes: rootCaMount } : {}),
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
  }

  if (enabled.has("mystampa")) {
    services.mystampa = {
      image: "ghcr.io/mysagra/mysagra-mystampa:latest",
      container_name: containerName("mystampa"),
      profiles: [SERVICE_BY_ID.get("mystampa")!.profile!],
      restart: "always",
      ...publish("mystampa"),
      env_file: [".env"],
      environment: [
        "NODE_ENV=${NODE_ENV:-production}",
        "API_KEY=${MYSTAMPA_API_KEY}",
        "API_URL=${API_URL}",
        ...rootCaEnv,
      ],
      depends_on: healthyDep("mysagra-backend"),
      volumes: ["./assets:/app/assets", "mystampa_config:/app/data", ...rootCaMount],
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
    volumes.mystampa_config = { driver: "local" };
  }

  if (enabled.has("mynumeri")) {
    services.mynumeri = {
      image: "ghcr.io/mysagra/mysagra-mynumeri:latest",
      container_name: containerName("mynumeri"),
      profiles: [SERVICE_BY_ID.get("mynumeri")!.profile!],
      restart: "always",
      ...publish("mynumeri"),
      env_file: [".env"],
      environment: [
        "NODE_ENV=${NODE_ENV:-production}",
        "AUTH_URL=${AUTH_URL_NUMERI}",
        ...rootCaEnv,
      ],
      depends_on: healthyDep("mysagra-backend"),
      volumes: ["mynumeri_data:/app/data", ...rootCaMount],
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
    volumes.mynumeri_data = { driver: "local" };
  }

  if (enabled.has("myclienti")) {
    services.myclienti = {
      image: "ghcr.io/mysagra/mysagra-myclienti:latest",
      container_name: containerName("myclienti"),
      profiles: [SERVICE_BY_ID.get("myclienti")!.profile!],
      restart: "always",
      ...publish("myclienti"),
      env_file: [".env"],
      environment: [
        "NODE_ENV=${NODE_ENV:-production}",
        "CLIENTI_API_KEY=${MYCLIENTI_API_KEY}",
        "API_URL=${API_URL}",
        "REQUIRE_TABLE=${REQUIRE_TABLE}",
        "SHOW_NUMBERS=${SHOW_NUMBERS}",
        ...rootCaEnv,
      ],
      depends_on: healthyDep("mysagra-backend"),
      ...(rootCaMount.length ? { volumes: rootCaMount } : {}),
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
  }

  if (enabled.has("dbgate")) {
    services.dbgate = {
      image: "dbgate/dbgate:latest",
      container_name: containerName("dbgate"),
      profiles: [SERVICE_BY_ID.get("dbgate")!.profile!],
      restart: "always",
      ...publish("dbgate"),
      env_file: [".env"],
      environment: [
        "LOGIN=${DBGATE_USER}",
        "PASSWORD=${DBGATE_PASSWORD}",
        "CONNECTIONS=con1",
        "ENGINE_con1=mysql@dbgate-plugin-mysql",
        "SERVER_con1=db",
        "PORT_con1=3306",
        "USER_con1=${DB_USER:-mysagra}",
        "PASSWORD_con1=${DB_USER_PASSWORD}",
        "DATABASE_con1=${MYSQL_DATABASE:-mysagra}",
      ],
      depends_on: healthyDep("db"),
      volumes: ["dbgate_data:/root/.dbgate"],
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
    volumes.dbgate_data = { driver: "local" };
  }

  // ── Cloudflare Tunnel connector (optional) ──────────────────────────────
  if (derived.cloudflareEnabled) {
    services.cloudflared = {
      image: "cloudflare/cloudflared:latest",
      container_name: containerName("cloudflared"),
      profiles: ["cloudflared"],
      restart: "always",
      env_file: [".env"],
      command: ["tunnel", "--no-autoupdate", "run", "--token", "${CLOUDFLARE_TUNNEL_TOKEN}"],
      ...HARDENING,
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
  }

  // ── nginx connector (optional): container only, config owned by the dev ──
  if (derived.nginxEnabled) {
    services.nginx = {
      image: "nginx:alpine",
      container_name: containerName("nginx"),
      profiles: ["nginx"],
      restart: "always",
      env_file: [".env"],
      ports: [`${80 + offset}:80`, `${443 + offset}:443`],
      volumes: ["./nginx.conf:/etc/nginx/conf.d/default.conf:ro", "./certs:/etc/nginx/certs:ro"],
      healthcheck: {
        test: ["CMD", "nginx", "-t"],
        interval: "30s",
        timeout: "5s",
        retries: 3,
      },
      logging: LOGGING,
      networks: ["mysagra-network"],
    };
  }

  const doc = {
    // overridable so that several stacks can coexist on the same host
    name: "${COMPOSE_PROJECT_NAME:-mysagra}",
    services,
    volumes,
    networks: { "mysagra-network": { driver: "bridge" } },
  };

  const header = [
    "# docker-compose.yml generated by the MySagra installer",
    derived.proxyEnabled
      ? "# Simple setup: bundled Caddy reverse proxy with automatic TLS"
      : "# Advanced setup: no reverse proxy, services published on host ports",
    "# Enabled profiles (see COMPOSE_PROFILES in .env):",
    `#   ${derived.composeProfiles}`,
    "# Start with:  docker compose up -d",
    "",
  ].join("\n");

  return header + stringify(doc, { lineWidth: 0, singleQuote: false });
}
