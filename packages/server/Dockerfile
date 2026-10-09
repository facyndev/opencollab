# syntax=docker/dockerfile:1
# Relay server image. Build context: packages/server.

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
# postinstall runs `prisma generate`: it needs the schema, config and tsconfig (the latter decides the import extensions it emits).
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-slim
ENV NODE_ENV=production \
    RELAY_ADDR=0.0.0.0:8787
# Prisma detects the libssl version through openssl, which slim images lack.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The Prisma CLI (a devDependency) stays in node_modules: it applies the
# migrations on startup, so the whole tree is copied instead of pruned.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts /app/package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1)).catch(()=>process.exit(1))"]
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
