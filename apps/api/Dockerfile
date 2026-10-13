# syntax=docker/dockerfile:1
# Relay server image. Build context: the repo root (single pnpm workspace and lockfile).
#   docker build -f packages/server/Dockerfile .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/server/prisma ./packages/server/prisma
COPY packages/server/prisma.config.ts packages/server/tsconfig.json packages/server/tsconfig.build.json ./packages/server/
# postinstall runs `prisma generate`: it needs the schema, config and tsconfig (the latter decides the import extensions it emits).
RUN pnpm install --frozen-lockfile --filter @opencollab/server...
COPY packages/server/src ./packages/server/src
RUN pnpm --filter @opencollab/server build
# Self-contained node_modules for the runtime. The Prisma CLI (a devDependency)
# stays in it: it applies the migrations on startup, so nothing is pruned.
RUN pnpm --filter @opencollab/server deploy --legacy /deploy

FROM node:24-slim
ENV NODE_ENV=production \
    RELAY_ADDR=0.0.0.0:8787
# Prisma detects the libssl version through openssl, which slim images lack.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/server/dist ./dist
COPY --from=build --chown=node:node /app/packages/server/prisma ./prisma
COPY --from=build --chown=node:node /app/packages/server/prisma.config.ts /app/packages/server/package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1)).catch(()=>process.exit(1))"]
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
