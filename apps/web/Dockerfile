# syntax=docker/dockerfile:1
# Web image: Vite build served by nginx. Build context: the repo root
#   docker build -f apps/web/Dockerfile .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/ui ./packages/ui
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @opencollab/web...
RUN pnpm --filter @opencollab/ui build
COPY apps/web/index.html apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
COPY apps/web/src ./apps/web/src
RUN pnpm --filter @opencollab/web build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-qO-", "http://127.0.0.1:8080/"]
