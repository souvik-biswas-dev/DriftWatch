-- Multi-tenant: each project carries its own optional Discord webhook so a
-- user's alerts go to their own channel, not an operator-wide one. The
-- github_token_encrypted column already exists (001) and is now populated
-- per-project (AES-GCM encrypted at the app layer) for private repos.
ALTER TABLE projects ADD COLUMN discord_webhook_url TEXT NOT NULL DEFAULT '';
