# syntax=docker/dockerfile:1.7
# ─── build ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src

# version injected at build time (git tag / CI); falls back to package.json
ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION}
RUN NODE_ENV=production pnpm build


# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# docker-cli + compose are only needed when /var/run/docker.sock is mounted
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY --from=build /app/dist ./dist

# the user's working directory is mounted at /out
WORKDIR /out
VOLUME ["/out"]

ARG APP_VERSION
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.title="MySagra installer" \
      org.opencontainers.image.description="CLI wizard that generates the docker-compose, .env and Caddyfile of the MySagra stack" \
      org.opencontainers.image.source="https://github.com/MySagra/mysagra" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD []
