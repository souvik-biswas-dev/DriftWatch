<div align="center">

# DriftWatch

**A watchdog that tells you the moment your live servers stop matching your git-declared `docker-compose.yml`.**

Continuously compares the **real** state of your Docker containers against the
**declared** state in your GitHub repo, flags any divergence ("drift") within
~60 seconds, and optionally explains the fix with AI and alerts you on Discord.

[![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white)](https://kit.svelte.dev)
[![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Postgres](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)](https://neon.tech)
[![Redis](https://img.shields.io/badge/Redis-FF4438?logo=redis&logoColor=white)](https://upstash.com)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://www.docker.com)

**[Live demo →](https://driftwatch.pages.dev)**  ·  Architected & engineered by **[Souvik Biswas](https://souvikbiswas-portfolio.pages.dev)** · [GitHub](https://github.com/souvik-biswas-dev)

</div>

---

## What problem does it solve?

When you deploy with Docker, your `docker-compose.yml` in git is the **plan** —
"run nginx 1.25, this database, these env vars." Over time the **reality** on the
server drifts away from that plan: someone SSHes in and tweaks a value, a container
restarts on a stale image, a half-failed deploy leaves things inconsistent. Nobody
notices until something breaks.

**DriftWatch is the tripwire.** It catches five kinds of drift and surfaces them
in a dashboard (with optional AI-written fix suggestions and Discord alerts):

| Drift type | Meaning | Severity |
|---|---|---|
| `missing_container` | Declared in compose but not running | critical |
| `extra_container` | Running but not in compose | warning |
| `image_stale` | Running image tag ≠ declared tag | warning |
| `env_mismatch` | One or more env vars differ | warning |
| `port_changed` | Host port binding differs | info |

---

## How it works (multi-user, agent-push)

DriftWatch is a **multi-user SaaS**, not a single-project script. You host the
backend **once**; then anyone signs up, points a project at their GitHub repo, and
runs a tiny **agent** on the server they want monitored.

```
  USER'S OWN SERVER                          YOUR HOSTED BACKEND
 ┌───────────────────┐                      ┌──────────────────────┐
 │  Docker daemon     │                      │   declared state ◄───┼── GitHub
 │       ▲            │   pushes live state  │   (docker-compose)   │   repo
 │       │ reads      │  ──── HTTPS ───────► │                      │
 │  [DriftWatch agent]│   (per-project key)  │   diff → drift       │
 └───────────────────┘                      │   ├─ dashboard (UI)   │
                                            │   ├─ Discord alert    │
                                            │   └─ optional AI      │
                                            └──────────────────────┘
```

The key design choice: **the backend never connects into a user's Docker host.**
The agent reads local Docker and pushes state *out*, so it's safe to share with
strangers and works behind NAT/firewalls — the same model Datadog and Netdata use.

> **Want to run or deploy it?** See **[SETUP.md](SETUP.md)** — a step-by-step,
> 100% free-tier guide (Render + Cloudflare + Neon + Upstash): what to create,
> where to get each value, and how a user runs the agent.

**Per-user, not operator-wide:** GitHub tokens (for private repos) and Discord
webhooks are entered **per project** by each user — a user's private repo is read
with their own token (encrypted at rest with AES-256-GCM), and their alerts go to
their own channel. **AI is optional and off by default** — drift detection works
fully without it; add a Gemini key to enable AI summaries.

**Stack:** Go (Gin) · SvelteKit · Cloudflare Workers + Pages · Neon Postgres · Upstash Redis · Docker · optional Gemini 2.5 Flash

---

## Table of Contents

- [High-Level Design](#high-level-design)
- [Low-Level Design](#low-level-design)
- [Monorepo Layout](#monorepo-layout)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)

---

## High-Level Design

### System Overview

```
  USER'S SERVER                              GitHub Repo (docker-compose.yml)
 ┌──────────────────┐                          │              │
 │  Docker daemon    │                          │ push event   │ Contents API
 │       ▲ reads     │                          ▼              │ (declared)
 │  [DriftWatch      │                  ┌─────────────────┐    │
 │   agent]          │                  │ Cloudflare      │    │
 └───────┬──────────┘                  │ Worker (HMAC)   │    │
         │ POST live state              └────────┬────────┘    │
         │ /api/agent/state  (agent key)         │ forward     │
         ▼                                       ▼             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Go Backend (Gin)                           │
│                                                                     │
│  ┌──────────────────┐   ┌─────────────────┐   ┌────────────────┐   │
│  │  Ingest + Scan    │──▶│  Drift Engine   │──▶│  Gemini AI     │   │
│  │  (agent-pushed)   │   │  (Diff + Hash)  │   │  (OPTIONAL)    │   │
│  └──────────────────┘   └────────┬────────┘   └───────┬────────┘   │
│           │                      │                     │            │
│  ┌────────▼──────────────────────▼─────────────────────▼────────┐  │
│  │                       Postgres (Neon)                         │  │
│  │   users · projects · snapshots · drift_events                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────┐        ┌────────────────────┐              │
│  │  Upstash Redis     │        │  Discord Alerts     │              │
│  │  (live cache +     │        │  (per-project       │              │
│  │   SHA256 dedup)    │        │   webhook, opt.)    │              │
│  └────────────────────┘        └────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
               ▲ REST / JWT
┌──────────────┴──────────────┐
│   SvelteKit Dashboard       │   (Cloudflare Pages)
│   (projects, drifts, auth)  │
└─────────────────────────────┘
```

### Data Flow

1. **Agent push** — the agent on a user's server reads local Docker and `POST`s the
   live snapshot to `/api/agent/state`, authenticated by a per-project agent key
   (only the key's SHA-256 hash is stored). The backend caches the snapshot in
   Redis and runs a scan immediately.

2. **Declared state** — the backend fetches the project's `docker-compose.yml` from
   GitHub. Private repos are read with the user's **own** token (decrypted per scan);
   public repos need no token.

3. **Dedup** — a SHA-256 hash of the live state is stored in Upstash Redis. If it
   matches the previous run, the scan exits early — no DB write, no AI call.

4. **Diff** — the drift engine deterministically compares live vs declared and
   produces typed `DriftEvent` structs (the five drift types above).

5. **AI analysis (optional)** — if a Gemini key is configured, drift events are sent
   to Gemini 2.5 Flash with a strict JSON schema returning severity, a one-line fix
   command, an explanation, and a per-container breakdown. With no key, rule-based
   severity is used and the scan still records the drift.

6. **Persistence + alert** — snapshot and drift events are written to Postgres via
   sqlc-generated queries. If the project has a Discord webhook configured, an alert
   is fired (empty webhook = no-op, no error).

7. **Webhook path (optional)** — on a `git push`, a Cloudflare Worker verifies the
   GitHub HMAC-SHA256 signature and forwards to `/api/webhook/github`, triggering an
   immediate re-scan against the last agent-pushed state.

8. **Dashboard** — the SvelteKit SPA reads drift history and project status via
   JWT-authenticated REST endpoints.

### Component Responsibilities

| Component | Responsibility |
|---|---|
| DriftWatch Agent | Runs on the user's host; reads local Docker (read-only) and pushes state to the backend over HTTPS |
| Ingest + Scheduler | Receives agent pushes, caches live state in Redis, orchestrates the scan |
| Drift Engine | Deterministic diff of live vs declared state; produces typed `DriftEvent` structs |
| Gemini AI (optional) | LLM severity classification + fix suggestion; strict JSON output; off by default |
| Cloudflare Worker | GitHub webhook ingestion; HMAC verification; fast acknowledgement via `ctx.waitUntil` |
| GitHub Client | Fetches `docker-compose.yml` via the Contents API using each project's own token |
| Discord Alerts | Sends formatted embed messages on new unresolved drift (per-project webhook) |
| Redis (Upstash) | Live-state cache + deduplication keyed by project ID + state SHA256 |
| Postgres (Neon) | Persistent store for users, projects, snapshots, drift events |
| SvelteKit Dashboard | Auth, project management, drift event viewer |

---

## Low-Level Design

### Database Schema

```
users
├── id            UUID PK
├── email         TEXT UNIQUE
├── password_hash TEXT          (bcrypt)
└── created_at    TIMESTAMPTZ

projects
├── id                     UUID PK
├── user_id                UUID FK → users.id
├── name                   TEXT
├── repo_owner             TEXT
├── repo_name              TEXT
├── repo_branch            TEXT  DEFAULT 'main'
├── agent_key_hash         TEXT  (SHA-256 of the per-project agent key)
├── github_token_encrypted TEXT  (AES-256-GCM, for private repos)
├── discord_webhook_url    TEXT  (per-project alerts; blank = none)
├── docker_host            TEXT  (legacy, unused in the agent-push model)
└── created_at / updated_at

snapshots
├── id             UUID PK
├── project_id     UUID FK → projects.id CASCADE
├── state_hash     TEXT       (SHA256 of live+declared JSON)
├── live_state     JSONB
├── declared_state JSONB
└── taken_at       TIMESTAMPTZ

drift_events
├── id             UUID PK
├── project_id     UUID FK → projects.id CASCADE
├── snapshot_id    UUID FK → snapshots.id
├── drift_type     TEXT  CHECK (env_mismatch | image_stale | port_changed | missing_container | extra_container)
├── container_name TEXT
├── live_value     TEXT
├── declared_value TEXT
├── severity       TEXT  CHECK (critical | warning | info)
├── ai_summary     TEXT
├── fix_command    TEXT
├── alerted_at     TIMESTAMPTZ
├── resolved_at    TIMESTAMPTZ
└── created_at     TIMESTAMPTZ

Indexes: snapshots.project_id · drift_events.project_id · drift_events.created_at DESC
         projects.user_id · projects.(repo_owner, repo_name)
```

### Drift Detection Engine (`internal/agent/diff.go`)

Five drift categories, each mapped to a severity:

| Drift Type | Trigger | Severity |
|---|---|---|
| `missing_container` | Declared in compose, not running | `critical` |
| `extra_container` | Running but not in compose | `warning` |
| `image_stale` | Running image tag ≠ declared image tag | `warning` |
| `env_mismatch` | One or more env vars differ | `warning` |
| `port_changed` | Host port binding differs | `info` |

Diff algorithm:
1. Index live containers and declared containers by service name.
2. Walk the union of names in alphabetical order (stable output).
3. For each name: detect missing/extra first, then image, env (sorted key walk), port.
4. Each `DriftEvent` carries a UUID, detected timestamp, and both live/declared values.

### Scheduler / ingest (`internal/scheduler/`)

Scans are **driven by the agent**, not a poll loop. When the agent pushes state:

```
IngestLiveState(projectID, liveSnapshot)
├── Redis SET driftwatch:live:<id>   (cache the agent's snapshot, 24h TTL)
└── runProjectScan(project)
    ├── load live state from Redis cache
    ├── Compute SHA256(live JSON)
    ├── Redis GET driftwatch:hash:<id> → match? → return early (dedup)
    ├── decrypt project's GitHub token (if any) → fetch docker-compose.yml
    ├── agent.Diff(live, declared) → []DriftEvent
    ├── gemini.Analyze(events) → AnalysisResult   (only if a Gemini key is set)
    ├── db.CreateSnapshot + db.CreateDriftEvent rows
    ├── Redis SET driftwatch:hash:<id>
    └── alerts.SendDriftAlertTo(project.discord_webhook_url, …)  (no-op if empty)
```

- The GitHub webhook path re-scans against the **last agent-pushed** state cached
  in Redis, so a `git push` produces an immediate diff without polling.
- `Stop()` drains in-flight scans before the process exits (30-second window).

### Gemini AI (`internal/gemini/agent.go`) — optional

- Off by default. Enabled only when `GEMINI_API_KEY` is set; otherwise drift
  detection runs with rule-based severity and no AI call.
- Calls `gemini-2.5-flash:generateContent` (free tier) via the v1beta REST API
  (no SDK dependency). Model overridable with `GEMINI_MODEL`.
- Strict JSON schema; returns `AnalysisResult` with `severity`, `summary`,
  `fixCommand`, `explanation`, `driftBreakdown[]`. Retries once on transient errors.

### Cloudflare Worker (`webhook-worker/src/index.ts`)

```
POST /webhook/github
├── Read raw body as ArrayBuffer (signature must be over raw bytes)
├── Web Crypto API: HMAC-SHA256 verify against GITHUB_WEBHOOK_SECRET
├── Parse JSON payload → extract repo full name, ref, after (commit SHA)
├── Return 200 immediately
└── ctx.waitUntil(
      fetch(BACKEND_URL + /api/webhook/github, {
        method: POST,
        headers: { X-DriftWatch-Secret: DRIFTWATCH_SECRET },
        body: ForwardedPayload JSON
      })
    )
```

GitHub never blocks on backend latency — the worker acknowledges the delivery before the backend has processed it.

### REST API (`internal/api/`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | — | Create user account |
| POST | `/api/auth/login` | — | Returns JWT |
| POST | `/api/agent/state` | Agent-key header | Ingest live Docker state pushed by an agent |
| POST | `/api/webhook/github` | Shared secret header | Trigger project re-scan on push |
| POST | `/api/projects` | JWT | Create project → returns one-time `agent_key` |
| GET | `/api/projects` | JWT | List user's projects |
| GET | `/api/projects/:id` | JWT | Get project detail |
| DELETE | `/api/projects/:id` | JWT | Delete + unregister from scheduler |
| GET | `/api/projects/:id/drifts` | JWT | Paginated drift event list |
| GET | `/api/projects/:id/drifts/:driftId` | JWT | Single drift event |
| POST | `/api/projects/:id/drifts/:driftId/resolve` | JWT | Mark drift resolved |

JWT middleware validates `Authorization: Bearer <token>`, sets `userID` in Gin context. All project endpoints enforce ownership — users can only access their own projects.

### Server Startup Sequence

```
1. godotenv.Load()                    load .env
2. runMigrations(DATABASE_URL)        golang-migrate via embedded FS (iofs)
3. pgxpool.New(...)                   pool: max 10, min 2, 30m lifetime
4. redis.NewClient(REDIS_URL)         supports rediss:// for Upstash TLS
5. db.New(pool)                       sqlc queries
6. github/gemini/alerts clients       integration layer
7. scheduler.NewScheduler(...)
8. sched.LoadAllProjects(ctx)         re-register persisted projects
9. sched.Start()                      cron loop begins
10. gin.New() + RegisterRoutes(...)   HTTP layer
11. http.Server.ListenAndServe        serve on :PORT
12. SIGTERM → server.Shutdown(30s)   graceful drain
    → sched.Stop()                   wait for in-flight scans
```

### SvelteKit Dashboard (`dashboard/`)

```
src/
├── lib/
│   ├── api.ts          typed fetch wrapper with JWT injection
│   ├── types.ts        Project, DriftEvent, User interfaces
│   ├── utils.ts        severity badge helpers, date formatting
│   └── stores/
│       └── projects.ts writable Svelte store for project list
└── routes/
    ├── +page.svelte           landing / redirect
    ├── login/+page.svelte     email+password auth form
    └── dashboard/
        ├── +page.svelte       project list
        └── [id]/+page.svelte  drift event timeline for a project
```

---

## Monorepo Layout

```
driftwatch/
├── backend/
│   ├── cmd/
│   │   ├── server/main.go      backend entrypoint — wires all components
│   │   └── agent/              standalone agent (runs on the user's host) + Dockerfile
│   ├── internal/
│   │   ├── agent/              diff engine + drift types
│   │   ├── alerts/             Discord webhook client (per-project)
│   │   ├── api/                Gin handlers + router + JWT/agent-key auth
│   │   ├── crypto/             AES-256-GCM encryption for secrets at rest
│   │   ├── db/                 sqlc-generated queries + hand-written agent queries
│   │   ├── docker/             Docker state reader (used by the agent)
│   │   ├── gemini/             Gemini 2.5 Flash REST client (optional)
│   │   ├── github/             GitHub Contents API client (per-project token)
│   │   └── scheduler/          ingest + scan orchestrator
│   ├── migrations/             golang-migrate SQL files (embedded via iofs)
│   ├── queries/                sqlc source SQL
│   ├── Dockerfile
│   ├── Makefile
│   ├── render.yaml             Render.com deploy config
│   └── sqlc.yaml
├── dashboard/                  SvelteKit SPA (Cloudflare Pages)
│   └── src/
│       ├── lib/                api client, Logo component, stores
│       └── routes/
└── webhook-worker/             Cloudflare Worker (TypeScript)
    └── src/
        ├── index.ts
        └── index.test.ts
```

---

## Quick Start

### Backend

```bash
cd driftwatch/backend
cp .env.example .env
# minimum to boot: DATABASE_URL, REDIS_URL, JWT_SECRET  (everything else optional)
go mod tidy
make dev          # migrations also run automatically on startup
```

Server boots on `http://localhost:8080`. Health: `GET /health` · deep status
(DB + Redis): `GET /status`.

### Dashboard

```bash
cd driftwatch/dashboard
npm install --legacy-peer-deps    # an .npmrc sets this; CI uses it too
npm run dev
```

Dashboard runs on `http://localhost:5173`. Set `ALLOWED_ORIGIN` in the backend
`.env` to match (no trailing slash).

### Webhook Worker

```bash
cd driftwatch/webhook-worker
npm install

# local dev
cp .dev.vars.example .dev.vars   # fill in secrets
npm run dev

# deploy
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put DRIFTWATCH_SECRET
wrangler deploy
```

### Agent (run on the machine that has Docker)

The agent reads your local Docker state and pushes it to the backend over HTTPS —
it's the only thing an end user installs. Each project gets its own agent key
(shown once when you create the project). Full walkthrough in **[SETUP.md](SETUP.md)**.

```bash
# build the image once (from the backend folder)
cd driftwatch/backend
docker build -f cmd/agent/Dockerfile -t driftwatch-agent .

# run it on the server that runs your containers
docker run -d --name driftwatch-agent --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e DRIFTWATCH_URL="https://your-backend-url" \
  -e DRIFTWATCH_AGENT_KEY="dw_...key shown when you created the project..." \
  driftwatch-agent
```

---

## Environment Variables

These are **backend** (operator) variables. GitHub tokens and Discord webhooks are
configured **per project** by each user in the dashboard — not here.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `REDIS_URL` | yes | Upstash Redis URL — **`rediss://`** (TLS) for Upstash |
| `JWT_SECRET` | yes | Secret for signing login JWTs (`openssl rand -base64 48`) |
| `ENCRYPTION_KEY` | yes* | Encrypts users' stored GitHub tokens (AES-256-GCM). Required for real multi-user; blank = tokens stored plaintext (dev only) |
| `WEBHOOK_SECRET` | no | Shared secret with the Cloudflare Worker; needed only if you deploy it |
| `GEMINI_API_KEY` | no | Google AI Studio key — **AI is off by default**; blank = no AI summaries |
| `GEMINI_MODEL` | no | Gemini model (default `gemini-2.5-flash`) |
| `GITHUB_TOKEN` | no | Operator-wide fallback token; normally blank (per-project tokens are used) |
| `DISCORD_WEBHOOK_URL` | no | Operator-wide fallback; normally blank (per-project webhooks are used) |
| `PORT` | no | HTTP port (default `8080`) |
| `ALLOWED_ORIGIN` | no | CORS origin of the dashboard (e.g. `https://driftwatch.pages.dev`) |

---

## API Reference

All protected routes require `Authorization: Bearer <jwt>`.

Error envelope: `{ "error": "message", "code": "ERROR_CODE" }`  
Success envelope: `{ "data": {...}, "message": "..." }`
