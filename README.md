# DriftWatch

Autonomous infrastructure drift detection — continuously diffs live Docker state against GitHub-declared `docker-compose.yml`, classifies divergence with Gemini AI, and fires Discord alerts within 60 seconds of any change.

**Stack:** Go · SvelteKit · Cloudflare Workers · Neon Postgres · Upstash Redis · Gemini 1.5 Flash

> **Want to run or share it?** See **[SETUP.md](SETUP.md)** — a step-by-step,
> 100% free-tier guide: what to create, where to get each value, how to host the
> backend for free, and how anyone runs the agent on their own server.

DriftWatch is a **multi-user tool**, not a single-project script. You host the
backend once; then anyone can sign up, create a project, and run a small **agent**
on their own server. The agent reads their local Docker and pushes the state to
the backend over HTTPS — the backend never connects into a user's Docker host, so
it's safe to share and works behind NAT/firewalls.

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
┌─────────────────────────────────────────────────────────────────────┐
│  GitHub Repo                                                        │
│  (docker-compose.yml)                                               │
└──────────────┬───────────────────────────┬──────────────────────────┘
               │ push event                │ REST (fetch file)
               ▼                           ▼
┌──────────────────────┐       ┌───────────────────────┐
│  Cloudflare Worker   │       │   GitHub Client (Go)  │
│  (HMAC-SHA256 verify)│──────▶│   Fetch compose YAML  │
└──────────────────────┘       └──────────┬────────────┘
         webhook forward                  │ declared state
                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Go Backend (Gin)                             │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │  Cron Scheduler │───▶│  Drift Engine   │───▶│  Gemini Agent  │  │
│  │  (@every 60s)   │    │  (Diff + Hash)  │    │  (AI analysis) │  │
│  └─────────────────┘    └────────┬────────┘    └───────┬────────┘  │
│           │                      │                      │           │
│           │              ┌───────┴───────┐              │           │
│           │              │  Docker Engine│              │           │
│           │              │  API (live)   │              │           │
│           │              └───────────────┘              │           │
│           │                                             │           │
│  ┌────────▼─────────────────────────────────────────── ▼────────┐  │
│  │                    Postgres (Neon)                            │  │
│  │   users · projects · snapshots · drift_events                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                          │                          │
│  ┌────────────────────┐        ┌─────────▼──────────┐              │
│  │  Upstash Redis     │        │  Discord Alerts     │              │
│  │  (SHA256 dedup)    │        │  (webhook notify)   │              │
│  └────────────────────┘        └────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
               ▲
               │ REST / JWT
┌──────────────┴──────────────┐
│   SvelteKit Dashboard       │
│   (projects, drifts, auth)  │
└─────────────────────────────┘
```

### Data Flow

1. **Webhook path** — GitHub fires a push event → Cloudflare Worker verifies HMAC-SHA256 signature → forwards to backend `/api/webhook/github` with a shared-secret header → backend triggers an immediate out-of-schedule scan for the affected project.

2. **Scheduled path** — Cron scheduler fires every 60 seconds per registered project → Docker Engine API fetches live container state → GitHub client fetches declared `docker-compose.yml` → Diff engine compares both snapshots.

3. **Dedup** — SHA256 hash of the combined live + declared state is stored in Upstash Redis. If the hash matches the previous run, the scan exits early — no DB write, no Gemini call.

4. **AI analysis** — On a new state hash, drift events are serialized and sent to Gemini 1.5 Flash with a strict JSON schema. The response includes severity, fix command, explanation, and per-container breakdown.

5. **Persistence** — Snapshot + drift events are written to Postgres via sqlc-generated type-safe queries. Discord alert is fired if the drift is unresolved.

6. **Dashboard** — SvelteKit SPA reads drift history and project status via JWT-authenticated REST endpoints.

### Component Responsibilities

| Component | Responsibility |
|---|---|
| Cloudflare Worker | GitHub webhook ingestion; HMAC verification; fast acknowledgement via `ctx.waitUntil` |
| Cron Scheduler | Per-project goroutine-safe job registry; 60-second polling cadence |
| Drift Engine | Deterministic diff of live vs declared state; produces typed `DriftEvent` structs |
| Gemini Agent | LLM-based severity classification and fix suggestion; strict JSON output |
| GitHub Client | Fetches raw `docker-compose.yml` from any branch via GitHub Contents API |
| Docker Client | Reads live container state (image, env, ports) via Docker Engine API |
| Discord Alerts | Sends formatted embed messages on new unresolved drift |
| Redis (Upstash) | Deduplication cache keyed by project ID + state SHA256 |
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
├── id                    UUID PK
├── user_id               UUID FK → users.id
├── name                  TEXT
├── repo_owner            TEXT
├── repo_name             TEXT
├── repo_branch           TEXT  DEFAULT 'main'
├── docker_host           TEXT  (tcp://host:2375 or unix socket)
├── github_token_encrypted TEXT (encrypted at app layer)
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

### Scheduler (`internal/scheduler/scheduler.go`)

```
Scheduler
├── cron.Cron            robfig/cron v3 — goroutine-safe job registry
├── entries map[UUID]EntryID  tracks per-project cron entry for deregistration
└── runProjectScan(project)
    ├── Docker Engine API → LiveSnapshot
    ├── GitHub Contents API → docker-compose.yml → parse → LiveSnapshot
    ├── Compute SHA256(live+declared JSON)
    ├── Redis GET project:<id>:hash → match? → return early
    ├── agent.Diff(live, declared) → []DriftEvent
    ├── gemini.Analyze(events) → AnalysisResult  (if events > 0)
    ├── db.CreateSnapshot + db.CreateDriftEvents  (transaction)
    ├── Redis SET project:<id>:hash
    └── alerts.Send(events, analysis)  (if unresolved)
```

- `RegisterProject` / `UnregisterProject` are mutex-guarded to prevent race on `entries` map.
- `Stop()` calls `cron.Stop()` and waits on the returned context — guarantees in-flight scans finish before process exits (30-second drain window).
- `LoadAllProjects` is called at startup to re-register all existing DB projects.

### Gemini Agent (`internal/gemini/agent.go`)

- Calls `gemini-1.5-flash:generateContent` via the v1beta REST API (no SDK dependency).
- System prompt enforces a strict JSON schema; response is extracted from `candidates[0].content.parts[0].text`.
- Retries once on transient HTTP errors with a 2-second delay.
- Returns `AnalysisResult` with: `severity`, `summary`, `fixCommand`, `explanation`, `driftBreakdown[]`.

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
| POST | `/api/webhook/github` | Shared secret header | Trigger project scan on push |
| POST | `/api/projects` | JWT | Create project + register with scheduler |
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
│   ├── cmd/server/main.go      entrypoint — wires all components
│   ├── internal/
│   │   ├── agent/              diff engine + drift types
│   │   ├── alerts/             Discord webhook client
│   │   ├── api/                Gin handlers + router + JWT middleware
│   │   ├── db/                 sqlc-generated queries
│   │   ├── docker/             Docker Engine API client
│   │   ├── gemini/             Gemini 1.5 Flash REST client
│   │   ├── github/             GitHub Contents API client
│   │   └── scheduler/          cron-based project scan orchestrator
│   ├── migrations/             golang-migrate SQL files (embedded via iofs)
│   ├── queries/                sqlc source SQL
│   ├── Dockerfile
│   ├── Makefile
│   ├── render.yaml             Render.com deploy config
│   └── sqlc.yaml
├── dashboard/                  SvelteKit SPA
│   └── src/
│       ├── lib/
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
# fill in DATABASE_URL, REDIS_URL, JWT_SECRET, GEMINI_API_KEY, etc.
go mod tidy
make migrate
make dev
```

Server boots on `http://localhost:8080`. Health check: `GET /health`.

### Dashboard

```bash
cd driftwatch/dashboard
npm install
npm run dev
```

Dashboard runs on `http://localhost:5173`. Set `ALLOWED_ORIGIN` in backend `.env` to match.

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

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string |
| `REDIS_URL` | yes | Upstash Redis URL (`rediss://...`) |
| `JWT_SECRET` | yes | Secret for signing JWTs |
| `WEBHOOK_SECRET` | yes | Shared secret with Cloudflare Worker |
| `GEMINI_API_KEY` | no | Google AI Studio API key — **optional, AI is off by default**. Blank = no AI summaries |
| `GITHUB_TOKEN` | no | GitHub PAT for fetching compose files — only needed for **private** repos |
| `DISCORD_WEBHOOK_URL` | no | Discord channel webhook for alerts |
| `PORT` | no | HTTP port (default `8080`) |
| `ALLOWED_ORIGIN` | no | CORS origin (default `http://localhost:5173`) |

---

## API Reference

All protected routes require `Authorization: Bearer <jwt>`.

Error envelope: `{ "error": "message", "code": "ERROR_CODE" }`  
Success envelope: `{ "data": {...}, "message": "..." }`
