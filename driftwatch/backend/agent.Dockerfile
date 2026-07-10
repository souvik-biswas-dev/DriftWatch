# syntax=docker/dockerfile:1
# DriftWatch agent — runs on the user's own host next to their Docker daemon.
#
# Build from the backend/ directory:
#   docker build -f agent.Dockerfile -t driftwatch-agent .
#
# Run:
#   docker run -d --name driftwatch-agent --restart unless-stopped \
#     -v /var/run/docker.sock:/var/run/docker.sock:ro \
#     -e DRIFTWATCH_URL=https://your-backend \
#     -e DRIFTWATCH_AGENT_KEY=dw_... \
#     driftwatch-agent

FROM node:22-alpine AS build
WORKDIR /src

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json ./

ENV NODE_ENV=production

# The agent only reads; it never writes to the socket. Mount it read-only.
CMD ["node", "dist/agent/main.js"]
