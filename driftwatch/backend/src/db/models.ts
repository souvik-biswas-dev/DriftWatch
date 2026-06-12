/**
 * Row shapes for the four tables. Field names are the column names, because
 * several handlers return rows straight to the dashboard and the API contract
 * is snake_case.
 */

export interface Project {
	id: string;
	name: string;
	repo_owner: string;
	repo_name: string;
	repo_branch: string;
	/** Legacy. Unused in the agent-push model; the column is kept for compatibility. */
	docker_host: string;
	github_token_encrypted: string | null;
	agent_key_hash: string;
	discord_webhook_url: string;
	created_at: Date;
	updated_at: Date;
	user_id: string | null;
	last_scanned_at: Date | null;
}

export interface Snapshot {
	id: string;
	project_id: string;
	state_hash: string;
	live_state: unknown;
	declared_state: unknown;
	taken_at: Date;
}

export interface DriftEventRow {
	id: string;
	project_id: string;
	snapshot_id: string;
	drift_type: string;
	container_name: string;
	live_value: string | null;
	declared_value: string | null;
	severity: string;
	ai_summary: string | null;
	fix_command: string | null;
	alerted_at: Date | null;
	resolved_at: Date | null;
	created_at: Date;
}

export interface User {
	id: string;
	email: string;
	password_hash: string | null;
	created_at: Date;
	github_id: string | null;
	github_login: string;
	avatar_url: string;
	github_token_encrypted: string;
}

/** The public profile fields returned by the OAuth upsert and /api/me. */
export interface GithubUser {
	id: string;
	email: string;
	github_login: string;
	avatar_url: string;
}
