# syntax=docker/dockerfile:1
# Relay server image. Build context: the repo root (single pnpm workspace and lockfile).
#   docker build -f apps/api/Dockerfile .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/domain ./packages/domain
COPY packages/contracts ./packages/contracts
COPY apps/api/package.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
# postinstall runs `prisma generate`: it needs the schema, config and tsconfig (the latter decides the import extensions it emits).
RUN pnpm install --frozen-lockfile --filter @opencollab/server...
RUN pnpm --filter @opencollab/domain build
RUN pnpm --filter @opencollab/contracts build
COPY apps/api/src ./apps/api/src
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
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/prisma.config.ts /app/apps/api/package.json ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>process.exit(t==='ok'?0:1)).catch(()=>process.exit(1))"]
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
