-- GitHub OAuth identity. Users now sign in with GitHub instead of a password,
-- so password_hash becomes optional and we store the GitHub identity plus the
-- user's OAuth access token (encrypted at the app layer) for reusing on private
-- repo fetches.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT '';
ALTER TABLE users ADD COLUMN github_id BIGINT;
ALTER TABLE users ADD COLUMN github_login TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN github_token_encrypted TEXT NOT NULL DEFAULT '';

-- One account per GitHub identity. Partial index so legacy email-only rows
-- (github_id IS NULL) don't collide.
CREATE UNIQUE INDEX idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL;

-- A GitHub user may keep their email private, so email can be empty. Replace the
-- table-wide UNIQUE on email with a partial unique index that ignores empties,
-- so multiple GitHub users without an email don't collide.
ALTER TABLE users ALTER COLUMN email SET DEFAULT '';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email <> '';
