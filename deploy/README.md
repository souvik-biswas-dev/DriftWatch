# Deploying DriftWatch

Three pieces, deployed independently:

| Piece | Where | What it needs |
|---|---|---|
| Backend (Node/Express) + Postgres + Redis | your VPS, via this compose file | a domain pointed at the VPS, ports 80/443 open |
| Dashboard (SvelteKit SPA) | Cloudflare Pages | the backend URL at build time |
| Webhook worker (optional) | Cloudflare Workers | the backend URL + a shared secret |

---

## 1. Backend on the VPS

```sh
git clone git@github.com:souvik-biswas-dev/DriftWatch.git
cd DriftWatch/deploy
cp .env.example .env
$EDITOR .env          # fill in every value
docker compose up -d --build
```

Migrations run automatically on boot — there is no separate migrate step.

Check it:

```sh
curl https://$API_DOMAIN/health     # {"status":"ok"}
curl https://$API_DOMAIN/status     # also proves Postgres + Redis are reachable
docker compose logs -f backend
```

`/status` returning `503` with `"postgres":"down"` or `"redis":"down"` means the
backend is up but a datastore isn't — check `docker compose ps`.

### Updating

```sh
cd DriftWatch && git pull
cd deploy && docker compose up -d --build backend
```

### Backups

The only durable state is Postgres:

```sh
docker compose exec -T postgres pg_dump -U driftwatch driftwatch | gzip > backup-$(date +%F).sql.gz
```

---

## 2. Dashboard on Cloudflare Pages

Create a Pages project pointed at this repo:

| Setting | Value |
|---|---|
| Root directory | `driftwatch/dashboard` |
| Build command | `npm run build` |
| Build output directory | `.svelte-kit/cloudflare` |
| Environment variable | `VITE_API_BASE_URL` = `https://<your API domain>` (no trailing slash) |

The output directory comes from `@sveltejs/adapter-cloudflare`, and the repo's
`.npmrc` already sets `legacy-peer-deps`, so the install needs no extra flag.

`VITE_API_BASE_URL` is baked in at build time, so changing it needs a redeploy,
not just a restart. Set it for **both** the production and preview environments,
or preview deploys will call `localhost:8080`.

---

## 3. Webhook worker (optional — instant scans on `git push`)

Without it, drift is still detected on every agent push and on the 60-second
interval. With it, a `git push` triggers a scan immediately.

```sh
cd driftwatch/webhook-worker
npm install
wrangler secret put GITHUB_WEBHOOK_SECRET   # also set as the secret on the GitHub webhook
wrangler secret put DRIFTWATCH_SECRET       # must equal the backend's WEBHOOK_SECRET
wrangler deploy
```

`BACKEND_URL` lives in `wrangler.toml` `[vars]`. Then add a webhook on the repo
(Settings → Webhooks): the worker URL, content type `application/json`, secret =
`GITHUB_WEBHOOK_SECRET`, just the push event.

---

## Wiring checklist

These four must agree exactly, or sign-in breaks in ways that look like CORS bugs:

1. GitHub OAuth App **Authorization callback URL** = `${BACKEND_URL}/api/auth/github/callback`
2. `BACKEND_URL` in the backend `.env` = the domain Caddy serves
3. `DASHBOARD_URL` = the Pages URL the callback redirects back to
4. `ALLOWED_ORIGIN` = the Pages origin the browser sends (a trailing slash is
   tolerated; a wrong scheme or host is not)
