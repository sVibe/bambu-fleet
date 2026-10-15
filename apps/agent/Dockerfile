# Build from the repository root:  docker build -f apps/agent/Dockerfile -t bambu-fleet-agent .
FROM node:24-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/threemf/package.json packages/threemf/
COPY apps/agent/package.json apps/agent/
COPY apps/cloud/package.json apps/cloud/
RUN pnpm install --frozen-lockfile --prod --filter "@fleet/agent..."

COPY packages/shared/src packages/shared/src
COPY packages/threemf/src packages/threemf/src
COPY apps/agent/src apps/agent/src

WORKDIR /app/apps/agent
ENV NODE_ENV=production \
    AGENT_CONFIG=/config/agent.yaml \
    AGENT_DATA_DIR=/data
VOLUME ["/data"]
USER node
# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
CMD ["node", "src/main.ts", "run"]
