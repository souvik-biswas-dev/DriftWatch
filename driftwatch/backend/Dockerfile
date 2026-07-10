# syntax=docker/dockerfile:1.6
#
# DriftWatch backend — multi-stage build.
# Final image is node:22-alpine + dist/ + production deps.

FROM node:22-alpine AS builder
WORKDIR /src

# Cache the dependency install independently from source changes.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve node_modules with dev dependencies pruned.
RUN npm ci --omit=dev

# --- Runtime stage ---
FROM node:22-alpine

RUN apk add --no-cache tzdata wget \
    && addgroup -S driftwatch \
    && adduser -S -G driftwatch driftwatch

WORKDIR /app
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist
COPY package.json ./
COPY migrations ./migrations

USER driftwatch:driftwatch

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
