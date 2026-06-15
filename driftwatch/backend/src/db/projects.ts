import type { Queryable } from './pool.js';
import type { Project } from './models.js';

const COLUMNS = `id, name, repo_owner, repo_name, repo_branch, docker_host,
	github_token_encrypted, agent_key_hash, discord_webhook_url,
	created_at, updated_at, user_id, last_scanned_at`;

export interface CreateProjectParams {
	name: string;
	repo_owner: string;
	repo_name: string;
	repo_branch: string;
	docker_host: string;
	github_token_encrypted: string | null;
	user_id: string | null;
}

export async function createProject(
	db: Queryable,
	arg: CreateProjectParams
): Promise<Project> {
	const { rows } = await db.query<Project>(
		`INSERT INTO projects (
			name, repo_owner, repo_name, repo_branch, docker_host,
			github_token_encrypted, user_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING ${COLUMNS}`,
		[
			arg.name,
			arg.repo_owner,
			arg.repo_name,
			arg.repo_branch,
			arg.docker_host,
			arg.github_token_encrypted,
			arg.user_id
		]
	);
	return rows[0]!;
}

/**
 * Unscoped lookup. Used by the scheduler and webhook (which have no user
 * context). HTTP handlers MUST use getProjectByIdForUser instead.
 */
export async function getProjectById(
	db: Queryable,
	id: string
): Promise<Project | null> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects WHERE id = $1`,
		[id]
	);
	return rows[0] ?? null;
}

export async function getProjectByIdForUser(
	db: Queryable,
	id: string,
	userId: string
): Promise<Project | null> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects WHERE id = $1 AND user_id = $2`,
		[id, userId]
	);
	return rows[0] ?? null;
}

/**
 * Unscoped list — only used by the scheduler on boot to register a timer for
 * every project. NOT for HTTP handlers.
 */
export async function listProjects(db: Queryable): Promise<Project[]> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects ORDER BY created_at DESC`
	);
	return rows;
}

export async function listProjectsForUser(
	db: Queryable,
	userId: string
): Promise<Project[]> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
		[userId]
	);
	return rows;
}

/**
 * Used by the GitHub webhook handler to fan out a scan to every project
 * tracking the repo the push landed on.
 */
export async function listProjectsByRepo(
	db: Queryable,
	repoOwner: string,
	repoName: string
): Promise<Project[]> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects WHERE repo_owner = $1 AND repo_name = $2`,
		[repoOwner, repoName]
	);
	return rows;
}

/** Returns the number of rows deleted (0 when the project isn't the user's). */
export async function deleteProjectForUser(
	db: Queryable,
	id: string,
	userId: string
): Promise<number> {
	const res = await db.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [
		id,
		userId
	]);
	return res.rowCount ?? 0;
}

/** Stores the SHA-256 hash of a project's agent key. */
export async function setProjectAgentKeyHash(
	db: Queryable,
	id: string,
	keyHash: string
): Promise<void> {
	await db.query(
		'UPDATE projects SET agent_key_hash = $2, updated_at = now() WHERE id = $1',
		[id, keyHash]
	);
}

/**
 * Stores a project's (already-encrypted) GitHub token and its Discord webhook
 * URL. Pass null token / empty url to clear them.
 */
export async function setProjectSecrets(
	db: Queryable,
	id: string,
	githubTokenEncrypted: string | null,
	discordWebhookUrl: string
): Promise<void> {
	await db.query(
		`UPDATE projects
		 SET github_token_encrypted = $2, discord_webhook_url = $3, updated_at = now()
		 WHERE id = $1`,
		[id, githubTokenEncrypted, discordWebhookUrl]
	);
}

/**
 * Looks up the project an agent is authorized to push state for, given the
 * hash of the key it presented.
 */
export async function getProjectByAgentKeyHash(
	db: Queryable,
	keyHash: string
): Promise<Project | null> {
	const { rows } = await db.query<Project>(
		`SELECT ${COLUMNS} FROM projects WHERE agent_key_hash = $1`,
		[keyHash]
	);
	return rows[0] ?? null;
}
