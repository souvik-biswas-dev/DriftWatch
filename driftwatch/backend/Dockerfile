# syntax=docker/dockerfile:1.6
#
# DriftWatch backend — multi-stage build.
# Final image is alpine + the static binary, ~20MB.

FROM golang:1.22-alpine AS builder
WORKDIR /src

# Cache module downloads independently from source changes.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

# Static build. CGO off so we can run on a stripped alpine without glibc.
# -ldflags shrinks the binary by stripping symbol tables and DWARF info.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- Runtime stage ---
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S driftwatch \
    && adduser -S -G driftwatch driftwatch

WORKDIR /app
COPY --from=builder /out/server /app/server

USER driftwatch:driftwatch

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["/app/server"]
