import { Octokit } from '@octokit/rest';
import { parse as parseYaml } from 'yaml';

import type { ContainerState, LiveSnapshot } from '../types.js';

export interface Repo {
	full_name: string;
	name: string;
	owner: string;
	private: boolean;
	description: string;
}

export interface Branch {
	name: string;
}

export interface GitHubClientOptions {
	/** Override the API root. Only used by tests. */
	baseUrl?: string;
}

export class GitHubClient {
	private readonly defaultToken: string;
	private readonly baseUrl: string | undefined;

	/**
	 * @param token operator-wide fallback token. Empty → unauthenticated, which
	 *   works for public repos (60 req/hr per IP).
	 */
	constructor(token: string, opts: GitHubClientOptions = {}) {
		this.defaultToken = token;
		this.baseUrl = opts.baseUrl;
	}

	private client(token: string): Octokit {
		return new Octokit({
			auth: token === '' ? undefined : token,
			...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
			userAgent: 'DriftWatch'
		});
	}

	/**
	 * Returns every repo (public + private) the token can access, across all
	 * pages. Used by the dashboard's repo picker.
	 */
	async listUserRepos(token: string): Promise<Repo[]> {
		const gh = this.client(token);
		const repos = await gh.paginate(gh.rest.repos.listForAuthenticatedUser, {
			sort: 'updated',
			per_page: 100
		});
		return repos.map((r) => ({
			full_name: r.full_name,
			name: r.name,
			owner: r.owner?.login ?? '',
			private: r.private,
			description: r.description ?? ''
		}));
	}

	/** Returns all branches for a repo. */
	async listRepoBranches(owner: string, repo: string, token: string): Promise<Branch[]> {
		const gh = this.client(token);
		const branches = await gh.paginate(gh.rest.repos.listBranches, {
			owner,
			repo,
			per_page: 100
		});
		return branches.map((b) => ({ name: b.name }));
	}

	/**
	 * Fetches a project's declared compose file using a per-project token. An
	 * empty token falls back to the operator-wide credentials — fine for public
	 * repos. This is what the multi-user scheduler calls, so each user's private
	 * repo is read with that user's own token.
	 */
	async fetchDeclaredConfigWithToken(
		owner: string,
		repo: string,
		branch: string,
		token: string
	): Promise<LiveSnapshot> {
		return this.fetchWith(token !== '' ? token : this.defaultToken, owner, repo, branch);
	}

	/** Uses the client's default (operator) credentials. */
	async fetchDeclaredConfig(
		owner: string,
		repo: string,
		branch: string
	): Promise<LiveSnapshot> {
		return this.fetchWith(this.defaultToken, owner, repo, branch);
	}

	private async fetchWith(
		token: string,
		owner: string,
		repo: string,
		branch: string
	): Promise<LiveSnapshot> {
		const gh = this.client(token);

		let data: Awaited<ReturnType<typeof gh.rest.repos.getContent>>['data'];
		try {
			({ data } = await gh.rest.repos.getContent({
				owner,
				repo,
				path: 'docker-compose.yml',
				ref: branch
			}));
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				throw new Error(`docker-compose.yml not found in ${owner}/${repo}@${branch}`);
			}
			throw new Error(
				`github: fetch docker-compose.yml: ${(err as Error).message}`
			);
		}

		if (Array.isArray(data) || data.type !== 'file') {
			throw new Error(
				`github: ${owner}/${repo}/docker-compose.yml is a directory, not a file`
			);
		}
		// GitHub omits the body for files over 1MB (encoding: "none").
		if (!data.content) {
			throw new Error('github: docker-compose.yml is too large to fetch inline');
		}

		const raw = Buffer.from(data.content, 'base64').toString('utf8');
		return parseCompose(raw);
	}
}

interface ComposeFile {
	services?: Record<string, ComposeService | null>;
}

interface ComposeService {
	image?: string;
	environment?: unknown;
	ports?: unknown;
}

/** Parses a docker-compose.yml body into the same shape the agent pushes. */
export function parseCompose(raw: string): LiveSnapshot {
	let compose: ComposeFile;
	try {
		compose = (parseYaml(raw) ?? {}) as ComposeFile;
	} catch (err) {
		throw new Error(`github: parse docker-compose.yml: ${(err as Error).message}`);
	}

	const containers: ContainerState[] = [];
	for (const [name, svc] of Object.entries(compose.services ?? {})) {
		containers.push({
			name,
			image: svc?.image ?? '',
			env: normalizeEnv(svc?.environment),
			ports: normalizePorts(svc?.ports),
			running: true
		});
	}

	return { containers, captured_at: new Date().toISOString() };
}

/**
 * normalizeEnv accepts the two YAML shapes docker-compose allows for
 * `environment` and returns a uniform record:
 *
 *   environment:               environment:
 *     - APP_ENV=prod      vs.    APP_ENV: prod
 *     - DEBUG=true               DEBUG: "true"
 */
export function normalizeEnv(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (raw === null || raw === undefined) return out;

	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item !== 'string') continue;
			const idx = item.indexOf('=');
			if (idx === -1) out[item] = '';
			else out[item.slice(0, idx)] = item.slice(idx + 1);
		}
		return out;
	}

	if (typeof raw === 'object') {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			// A key with no value (`DEBUG:`) means "inherit from the host
			// environment"; there is nothing to compare, so treat it as empty.
			out[k] = v === null || v === undefined ? '' : String(v);
		}
	}

	return out;
}

/**
 * normalizePorts coerces the `ports` list to strings. Quoted entries ("8080:80")
 * are already strings; a bare `- 8080:80` is parsed by YAML as a map, and a
 * single `- 3000` as a number.
 */
export function normalizePorts(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === 'string') out.push(item);
		else if (typeof item === 'number') out.push(String(item));
		else if (item && typeof item === 'object') {
			// Long syntax ({target: 80, published: 8080}) or an unquoted
			// "8080:80" that YAML read as {8080: 80}.
			const obj = item as Record<string, unknown>;
			if (obj.published !== undefined && obj.target !== undefined) {
				out.push(`${String(obj.published)}:${String(obj.target)}`);
			} else {
				for (const [k, v] of Object.entries(obj)) out.push(`${k}:${String(v)}`);
			}
		}
	}
	return out;
}
