import type { Queryable } from './pool.js';
import type { GithubUser, User } from './models.js';

export async function createUser(
	db: Queryable,
	email: string,
	passwordHash: string
): Promise<User> {
	const { rows } = await db.query<User>(
		`INSERT INTO users (email, password_hash)
		 VALUES ($1, $2)
		 RETURNING id, email, password_hash, created_at, github_id, github_login,
		           avatar_url, github_token_encrypted`,
		[email, passwordHash]
	);
	return rows[0]!;
}

export async function getUserByEmail(
	db: Queryable,
	email: string
): Promise<User | null> {
	const { rows } = await db.query<User>(
		`SELECT id, email, password_hash, created_at, github_id, github_login,
		        avatar_url, github_token_encrypted
		 FROM users WHERE email = $1`,
		[email]
	);
	return rows[0] ?? null;
}

export interface UpsertGithubUserParams {
	email: string;
	githubId: number;
	githubLogin: string;
	avatarUrl: string;
	githubTokenEncrypted: string;
}

/**
 * Creates or updates the user identified by their GitHub ID and returns the
 * account. The encrypted OAuth token is refreshed on every login.
 */
export async function upsertGithubUser(
	db: Queryable,
	arg: UpsertGithubUserParams
): Promise<GithubUser> {
	const { rows } = await db.query<GithubUser>(
		`INSERT INTO users (email, github_id, github_login, avatar_url, github_token_encrypted)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (github_id) WHERE github_id IS NOT NULL
		 DO UPDATE SET
			email = EXCLUDED.email,
			github_login = EXCLUDED.github_login,
			avatar_url = EXCLUDED.avatar_url,
			github_token_encrypted = EXCLUDED.github_token_encrypted
		 RETURNING id, email, github_login, avatar_url`,
		[
			arg.email,
			arg.githubId,
			arg.githubLogin,
			arg.avatarUrl,
			arg.githubTokenEncrypted
		]
	);
	return rows[0]!;
}

/**
 * Returns the encrypted GitHub OAuth token stored for a user, used to read
 * their private repos. Empty string when none is stored.
 */
export async function getUserGithubToken(
	db: Queryable,
	userId: string
): Promise<string> {
	const { rows } = await db.query<{ github_token_encrypted: string }>(
		'SELECT github_token_encrypted FROM users WHERE id = $1',
		[userId]
	);
	return rows[0]?.github_token_encrypted ?? '';
}

/** Returns the public profile fields for the authenticated user. */
export async function getUserProfile(
	db: Queryable,
	userId: string
): Promise<GithubUser | null> {
	const { rows } = await db.query<GithubUser>(
		'SELECT id, email, github_login, avatar_url FROM users WHERE id = $1',
		[userId]
	);
	return rows[0] ?? null;
}
