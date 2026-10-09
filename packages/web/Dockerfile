# syntax=docker/dockerfile:1
# Web image: Vite build served by nginx. Build context: the repo root
#   docker build -f packages/web/Dockerfile .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile --filter @opencollab/web...
COPY packages/web/index.html packages/web/tsconfig.json packages/web/vite.config.ts ./packages/web/
COPY packages/web/src ./packages/web/src
RUN pnpm --filter @opencollab/web build

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-qO-", "http://127.0.0.1:8080/"]
