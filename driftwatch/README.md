# DriftWatch

Autonomous infrastructure drift detection agent.

## Monorepo Layout

- `backend/` — Go API (Gin), agent runtime, scheduler, integrations (Docker, GitHub, Gemini), Postgres via sqlc.
- `dashboard/` — SvelteKit UI.
- `webhook-worker/` — Cloudflare Worker for receiving webhook events.

## Backend Quick Start

```bash
cd backend
cp .env.example .env
go mod tidy
make migrate
make dev
```

Server boots on `http://localhost:8080`. Health check: `GET /health`.
