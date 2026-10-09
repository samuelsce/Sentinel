# Local M1 environment. Production hardening belongs to the deployment milestone.
ARG IMAGE_PREFIX=
FROM ${IMAGE_PREFIX}node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base
RUN npm install --global pnpm@11.25.0
WORKDIR /workspace
RUN chown node:node /workspace
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/database/package.json packages/database/package.json
COPY --chown=node:node packages/sdk/package.json packages/sdk/package.json
COPY --chown=node:node apps/demo/package.json apps/demo/package.json
USER node
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .

FROM base AS api
CMD ["pnpm", "--filter", "@sentinel/api", "start"]

FROM base AS migrate
CMD ["pnpm", "db:migrate"]

FROM base AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @sentinel/web build
CMD ["pnpm", "--filter", "@sentinel/web", "start"]
