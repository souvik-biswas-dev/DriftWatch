## DriftWatch — Autonomous Infrastructure Drift Detection
*Go · SvelteKit · Cloudflare Workers · Neon Postgres · Upstash Redis · Gemini 1.5*

- Built a Go (Gin) backend with a goroutine-based cron scheduler that diffs Docker Engine API state against GitHub-declared `docker-compose.yml`, detecting 5 drift categories (env, image, port, missing/extra container) within 60 seconds of any state change.
- Integrated Gemini 1.5 Flash with strict JSON output validated against Go structs, gating LLM calls behind a SHA256 state-hash dedupe in Upstash Redis to eliminate redundant AI requests on unchanged container snapshots.
- Shipped a Cloudflare Worker for GitHub webhook ingestion with HMAC-SHA256 signature verification via the Web Crypto API, acknowledging deliveries through `ctx.waitUntil` so GitHub never blocks on backend latency.
- Designed the persistence layer on Neon Postgres with sqlc-generated type-safe queries, `golang-migrate` schema auto-application on boot, and a `pgx/v5` connection pool with a 30-second graceful-shutdown drain on SIGTERM.
