# DriftWatch — Setup Guide (100% free tier)

DriftWatch now works as a **multi-user tool**. There are two roles:

- **Operator (you)** — you host the backend **once**. Everything below in
  "Part 1" and "Part 2" is done by you, one time.
- **Users** — anyone signs up, creates a project, gets an **agent key**, and runs
  a tiny **agent** on their own server (Part 3). The backend never touches their
  Docker host — the agent reads it locally and pushes the state in. This is what
  makes it safe to share with strangers.

> **AI is optional and off by default.** Drift detection works fully without it.
> Add a Gemini key only if you want AI-written summaries and fix commands.

---

## Part 1 — Things you must create manually (and where to get them)

All of these have a free tier. Create each one, copy the value into the
backend `.env` file (`driftwatch/backend/.env`).

| What | Required? | Where to get it | What to copy |
|---|---|---|---|
| **Neon Postgres** | ✅ Yes | https://neon.tech → sign up → **Create project** | The **Pooled** connection string → `DATABASE_URL` |
| **Upstash Redis** | ✅ Yes | https://upstash.com → **Create Database** (Redis) | The `rediss://...` URL → `REDIS_URL` |
| **JWT secret** | ✅ Yes | Run `openssl rand -base64 48` in a terminal | The output → `JWT_SECRET` |
| **Webhook secret** | ✅ Yes | Run `openssl rand -base64 48` again | The output → `WEBHOOK_SECRET` (only matters if you deploy the Cloudflare worker) |
| **Gemini API key** | ⬜ Optional | https://aistudio.google.com/app/apikey → **Create API key** | The key → `GEMINI_API_KEY` (leave blank to disable AI) |
| **GitHub token** | ⬜ Optional | https://github.com/settings/tokens → **Fine-grained token** with `Contents: Read-only` | The token → `GITHUB_TOKEN` (only needed for **private** repos; public repos need nothing) |
| **Discord webhook** | ⬜ Optional | Discord channel → **Edit → Integrations → Webhooks → New Webhook → Copy URL** | The URL → `DISCORD_WEBHOOK_URL` (leave blank to disable alerts) |

### Step-by-step for the two required services

**Neon (database)**
1. Go to https://neon.tech and sign in with GitHub.
2. Click **Create project**, give it a name, pick a region near you.
3. On the dashboard, find **Connection string**, switch the toggle to
   **Pooled connection**, and copy it. It looks like
   `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require`.
4. Paste it as `DATABASE_URL` in `.env`.

**Upstash (Redis)**
1. Go to https://upstash.com and sign in.
2. Click **Create Database**, choose **Redis**, pick a region.
3. Open the database, scroll to **Connect**, copy the URL that starts with
   `rediss://` (the TLS one).
4. Paste it as `REDIS_URL` in `.env`.

That's the minimum. With just Neon + Upstash + the two secrets, DriftWatch runs.

---

## Part 2 — Host the backend for free

The backend is a single Go binary / Docker image. Any of these free options work.
The simplest is **Render**.

### Option A — Render (easiest, free, sleeps when idle)

1. Push this repo to your own GitHub.
2. Go to https://render.com → **New → Web Service** → connect the repo.
3. Settings:
   - **Root directory:** `driftwatch/backend`
   - **Runtime:** Docker (it will use `driftwatch/backend/Dockerfile`)
4. Under **Environment**, add every variable from your `.env`
   (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `WEBHOOK_SECRET`, and any optional
   ones you set).
5. Deploy. Render gives you a URL like `https://driftwatch-xxxx.onrender.com`.

> ⚠️ **Free tier note:** the service **sleeps after ~15 min of inactivity**, so
> the first request after idle takes ~30–60s to wake. That's fine for this tool —
> the agent just retries on the next tick.

`render.yaml` is already included for a one-click Render Blueprint if you prefer.

### Option B — Fly.io (stays warm longer on free allowance)

```bash
cd driftwatch/backend
fly launch            # creates fly.toml, pick a name/region
fly secrets set DATABASE_URL="..." REDIS_URL="..." JWT_SECRET="..." WEBHOOK_SECRET="..."
fly deploy
```

### Option C — Just run it locally (cost: nothing)

```bash
cd driftwatch/backend
cp .env.example .env   # fill in DATABASE_URL, REDIS_URL, JWT_SECRET
go mod tidy
make migrate           # creates the tables in Neon
make dev               # backend on http://localhost:8080
```

Migrations run automatically on startup too, so `make migrate` is optional.

---

## Part 3 — How a user adds a project and runs the agent

This is what **each user** does (including you, for your own servers).

1. **Sign up / log in** through the dashboard (or `POST /api/auth/register`).
2. **Create a project** — give it a name and the GitHub repo that holds your
   `docker-compose.yml` (owner + repo + branch). You no longer enter a Docker
   host.
3. The response includes a one-time **`agent_key`** (starts with `dw_`).
   **Copy it now — it is shown only once.**

   ```bash
   curl -X POST https://YOUR-BACKEND/api/projects \
     -H "Authorization: Bearer <your-jwt>" \
     -H "Content-Type: application/json" \
     -d '{"name":"my-stack","repo_owner":"me","repo_name":"infra","repo_branch":"main"}'
   # → { "data": {...}, "agent_key": "dw_abc123...", "message": "Save this agent key now..." }
   ```

4. **Run the agent on the server where Docker runs.** Easiest is Docker:

   ```bash
   docker run -d --name driftwatch-agent --restart unless-stopped \
     -v /var/run/docker.sock:/var/run/docker.sock:ro \
     -e DRIFTWATCH_URL="https://YOUR-BACKEND" \
     -e DRIFTWATCH_AGENT_KEY="dw_abc123..." \
     driftwatch-agent
   ```

   Build that image once from the backend folder:

   ```bash
   cd driftwatch/backend
   docker build -f cmd/agent/Dockerfile -t driftwatch-agent .
   ```

   Or run it without Docker:

   ```bash
   cd driftwatch/backend
   DRIFTWATCH_URL="https://YOUR-BACKEND" \
   DRIFTWATCH_AGENT_KEY="dw_abc123..." \
   go run ./cmd/agent
   ```

The agent reads local Docker every 60s (set `SCAN_INTERVAL=30s` to change it) and
pushes the state. The backend compares it to the declared `docker-compose.yml`
from GitHub and records any drift. Mounting the socket **read-only** (`:ro`) is
recommended — the agent only ever lists containers.

---

## Part 4 — Optional: instant scans on git push (Cloudflare Worker)

By default the backend re-scans whenever the agent pushes state. If you also want
a scan the moment someone pushes to GitHub, deploy the included worker (free):

```bash
cd driftwatch/webhook-worker
npm install
wrangler secret put GITHUB_WEBHOOK_SECRET   # any random string; also set it on the GitHub webhook
wrangler secret put DRIFTWATCH_SECRET        # must equal the backend's WEBHOOK_SECRET
wrangler deploy
```

Then add a GitHub webhook (repo → Settings → Webhooks) pointing at the worker URL,
content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`.

---

## Quick reference — what each env var is for

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon Postgres (pooled) |
| `REDIS_URL` | ✅ | Upstash Redis (`rediss://`) |
| `JWT_SECRET` | ✅ | Signs login tokens — `openssl rand -base64 48` |
| `WEBHOOK_SECRET` | ✅* | Shared with the Cloudflare worker; required only if you use it |
| `GEMINI_API_KEY` | ⬜ | AI summaries; blank = AI disabled (default) |
| `GITHUB_TOKEN` | ⬜ | Only for private repos; blank works for public repos |
| `DISCORD_WEBHOOK_URL` | ⬜ | Drift alerts; blank = no alerts |
| `PORT` | ⬜ | Defaults to `8080` |
| `ALLOWED_ORIGIN` | ⬜ | CORS origin of your dashboard |

---

## Known limitations / good next steps

- **Private repos per user:** the backend currently uses one operator-wide
  `GITHUB_TOKEN`. The `projects.github_token_encrypted` column already exists, but
  there is no endpoint yet to let each user save their own token. Public repos
  work for everyone today.
- **Agent key rotation:** keys are issued once at project creation. A
  "regenerate key" endpoint is a small future addition.
- **Dashboard:** the create-project form should drop the old "Docker host" field
  and display the returned `agent_key` + the `docker run` snippet above. The API
  is ready; the SvelteKit form just needs that cosmetic update.
