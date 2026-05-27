export interface Project {
	id: string;
	name: string;
	repo_owner: string;
	repo_name: string;
	repo_branch: string;
	docker_host: string;
	github_token_encrypted: string | null;
	created_at: string;
	updated_at: string;
}

export type DriftType =
	| 'env_mismatch'
	| 'image_stale'
	| 'port_changed'
	| 'missing_container'
	| 'extra_container';

export type Severity = 'critical' | 'warning' | 'info';

export interface DriftEvent {
	id: string;
	project_id: string;
	snapshot_id: string;
	drift_type: DriftType;
	container_name: string;
	live_value: string | null;
	declared_value: string | null;
	severity: Severity;
	ai_summary: string | null;
	fix_command: string | null;
	alerted_at: string | null;
	resolved_at: string | null;
	created_at: string;
}

export interface Snapshot {
	id: string;
	project_id: string;
	state_hash: string;
	live_state: unknown;
	declared_state: unknown;
	taken_at: string;
}

export interface User {
	id: string;
	email: string;
}

export interface LoginResponse {
	token: string;
	expires_at: string;
}

export interface ProjectDetail {
	project: Project;
	latest_snapshot: Snapshot | null;
}

export interface CreateProjectInput {
	name: string;
	repo_owner: string;
	repo_name: string;
	repo_branch: string;
	docker_host: string;
	github_token_encrypted?: string | null;
}

export interface ApiSuccess<T> {
	data: T;
	message: string;
}

export interface ApiError {
	error: string;
	code: string;
}
