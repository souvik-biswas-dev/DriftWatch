# syntax=docker/dockerfile:1
# DriftWatch agent — runs on the user's own host next to their Docker daemon.
# Build from the backend/ directory:
#   docker build -f cmd/agent/Dockerfile -t driftwatch-agent .
FROM golang:1.25-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /agent ./cmd/agent

FROM gcr.io/distroless/static-debian12
COPY --from=build /agent /agent
ENTRYPOINT ["/agent"]
