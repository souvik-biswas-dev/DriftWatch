import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Project } from '../db/models.js';
import type { Queryable } from '../db/pool.js';
import type { GitHubClient } from '../services/github.js';
import type { SchedulerAPI } from '../services/scheduler.js';
import type { LiveSnapshot } from '../types.js';
import { hashAgentKey } from './agentKey.js';
import { createApp } from './app.js';
import { issueJWT } from './auth.js';
import type { ApiDeps } from './deps.js';

const JWT_SECRET = 'test-jwt-secret';
const WEBHOOK_SECRET = 'test-webhook-secret';
const AGENT_KEY = 'dw_testagentkey';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

function projectRow(overrides: Partial<Project> = {}): Project {
	return {
		id: PROJECT_ID,
		name: 'acme-prod',
		repo_owner: 'acme',
		repo_name: 'widgets',
		repo_branch: 'main',
		docker_host: '',
		github_token_encrypted: 'enc:v1:sekrit',
		agent_key_hash: hashAgentKey(AGENT_KEY),
		discord_webhook_url: 'https://discord.test/hook',
		created_at: new Date('2026-01-01T00:00:00Z'),
		updated_at: new Date('2026-01-02T00:00:00Z'),
		user_id: USER_ID,
		last_scanned_at: null,
		...overrides
	};
}

/**
 * Stands in for the Postgres pool by matching on the SQL each query module
 * emits. Only the statements these tests exercise are answered.
 */
function fakeDb(): Queryable {
	return {
		query: (async (text: string, values: unknown[] = []) => {
			const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });

			if (text.includes('FROM projects WHERE agent_key_hash')) {
				return rows(values[0] === hashAgentKey(AGENT_KEY) ? [projectRow()] : []);
			}
			if (text.includes('FROM projects WHERE repo_owner')) {
				return rows(values[0] === 'acme' ? [projectRow()] : []);
			}
			if (text.includes('FROM projects WHERE id = $1 AND user_id')) {
				return rows(values[0] === PROJECT_ID ? [projectRow()] : []);
			}
			if (text.includes('FROM projects WHERE user_id')) {
				return rows([projectRow()]);
			}
			if (text.includes('INSERT INTO projects')) {
				return rows([projectRow({ discord_webhook_url: '' })]);
			}
			if (text.includes('SELECT id, email, github_login, avatar_url FROM users')) {
				return rows([
					{
						id: USER_ID,
						email: 'dev@example.com',
						github_login: 'octocat',
						avatar_url: 'https://avatars.test/octocat'
					}
				]);
			}
			return rows([]);
		}) as Queryable['query']
	};
}

const scheduler = {
	registerProject: vi.fn(),
	unregisterProject: vi.fn(),
	triggerScan: vi.fn(async () => undefined),
	ingestLiveState: vi.fn(async () => undefined)
} satisfies SchedulerAPI;

const deps: ApiDeps = {
	db: fakeDb(),
	scheduler,
	github: {} as GitHubClient,
	jwtSecret: JWT_SECRET,
	webhookSecret: WEBHOOK_SECRET,
	oauth: {
		clientId: '',
		clientSecret: '',
		dashboardUrl: 'http://localhost:5173',
		backendUrl: ''
	}
};

let server: Server;
let base: string;
let postgresUp = true;
let redisUp = true;

beforeAll(async () => {
	const app = createApp(deps, {
		allowedOrigin: 'https://driftwatch.pages.dev, http://localhost:5173',
		checkPostgres: async () => {
			if (!postgresUp) throw new Error('down');
		},
		checkRedis: async () => {
			if (!redisUp) throw new Error('down');
		}
	});
	server = app.listen(0, '127.0.0.1');
	await new Promise<void>((resolve) => server.once('listening', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

const authHeader = (): Record<string, string> => ({
	Authorization: `Bearer ${issueJWT(USER_ID, JWT_SECRET).token}`
});

describe('operational routes', () => {
	it('answers the root with a service banner', async () => {
		const res = await fetch(base + '/');
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			service: 'driftwatch-backend',
			status: 'ok'
		});
	});

	it('answers /health on GET and HEAD (uptime monitors probe with HEAD)', async () => {
		expect((await fetch(base + '/health')).status).toBe(200);
		expect((await fetch(base + '/health', { method: 'HEAD' })).status).toBe(200);
	});

	it('reports readiness, and 503 when a dependency is down', async () => {
		let res = await fetch(base + '/status');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: 'ok',
			postgres: 'ok',
			redis: 'ok'
		});

		redisUp = false;
		res = await fetch(base + '/status');
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ status: 'degraded', redis: 'down' });
		redisUp = true;
	});
});

describe('CORS', () => {
	it('answers a preflight for an allowed origin', async () => {
		const res = await fetch(base + '/api/projects', {
			method: 'OPTIONS',
			headers: { Origin: 'https://driftwatch.pages.dev' }
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe(
			'https://driftwatch.pages.dev'
		);
	});

	it('allows a Cloudflare Pages preview subdomain', async () => {
		const res = await fetch(base + '/health', {
			headers: { Origin: 'https://abc123.driftwatch.pages.dev' }
		});
		expect(res.headers.get('access-control-allow-origin')).toBe(
			'https://abc123.driftwatch.pages.dev'
		);
	});

	it('does not echo an unknown origin', async () => {
		const res = await fetch(base + '/health', {
			headers: { Origin: 'https://evil.example.com' }
		});
		expect(res.headers.get('access-control-allow-origin')).toBeNull();
	});
});

describe('authentication', () => {
	it('rejects a missing bearer token', async () => {
		const res = await fetch(base + '/api/projects');
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: 'AUTH_MISSING' });
	});

	it('rejects a token signed with the wrong secret', async () => {
		const res = await fetch(base + '/api/projects', {
			headers: { Authorization: `Bearer ${issueJWT(USER_ID, 'wrong').token}` }
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: 'AUTH_INVALID' });
	});

	it('returns the caller profile from /api/me', async () => {
		const res = await fetch(base + '/api/me', { headers: authHeader() });
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({
			id: USER_ID,
			email: 'dev@example.com',
			github_login: 'octocat',
			avatar_url: 'https://avatars.test/octocat'
		});
	});
});

describe('projects', () => {
	it('lists projects without leaking secrets', async () => {
		const res = await fetch(base + '/api/projects', { headers: authHeader() });
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			id: PROJECT_ID,
			name: 'acme-prod',
			has_github_token: true,
			has_discord_webhook: true
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain('enc:v1:sekrit');
		expect(serialized).not.toContain(hashAgentKey(AGENT_KEY));
	});

	it('returns the one-time agent key on create', async () => {
		const res = await fetch(base + '/api/projects', {
			method: 'POST',
			headers: { ...authHeader(), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'acme-prod',
				repo_owner: 'acme',
				repo_name: 'widgets'
			})
		});
		expect(res.status).toBe(201);

		const body = await res.json();
		expect(body.agent_key).toMatch(/^dw_[0-9a-f]{48}$/);
		expect(body.data.id).toBe(PROJECT_ID);
		expect(scheduler.registerProject).toHaveBeenCalled();
	});

	it('validates the request body', async () => {
		const res = await fetch(base + '/api/projects', {
			method: 'POST',
			headers: { ...authHeader(), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'no repo' })
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
	});

	it('rejects a malformed project id', async () => {
		const res = await fetch(base + '/api/projects/not-a-uuid', {
			headers: authHeader()
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'INVALID_ID' });
	});

	it('routes the nested drift list past the /projects/:id handler', async () => {
		const res = await fetch(base + `/api/projects/${PROJECT_ID}/drifts`, {
			headers: authHeader()
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('404s a project owned by someone else', async () => {
		const res = await fetch(
			base + '/api/projects/33333333-3333-3333-3333-333333333333',
			{ headers: authHeader() }
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
	});
});

describe('agent ingest', () => {
	const snapshot: LiveSnapshot = {
		containers: [
			{ name: 'web', image: 'nginx:1.25', env: { A: '1' }, ports: [], running: true }
		],
		captured_at: '2026-01-01T00:00:00.000Z'
	};

	const push = (headers: Record<string, string>) =>
		fetch(base + '/api/agent/state', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(snapshot)
		});

	it('rejects a push with no agent key', async () => {
		const res = await push({});
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: 'NO_AGENT_KEY' });
	});

	it('rejects an unknown agent key', async () => {
		const res = await push({ 'X-DriftWatch-Agent-Key': 'dw_wrong' });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: 'BAD_AGENT_KEY' });
	});

	it('accepts a valid push and hands it to the scheduler', async () => {
		scheduler.ingestLiveState.mockClear();

		const res = await push({ 'X-DriftWatch-Agent-Key': AGENT_KEY });
		expect(res.status).toBe(202);
		expect((await res.json()).data).toEqual({ project_id: PROJECT_ID });

		expect(scheduler.ingestLiveState).toHaveBeenCalledWith(PROJECT_ID, snapshot);
	});
});

describe('github webhook', () => {
	const post = (headers: Record<string, string>, body: unknown) =>
		fetch(base + '/api/webhook/github', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body)
		});

	it('rejects a bad shared secret', async () => {
		const res = await post({ 'X-DriftWatch-Secret': 'nope' }, {
			repo_full_name: 'acme/widgets'
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: 'WEBHOOK_AUTH' });
	});

	it('fans out a scan to every project tracking the repo', async () => {
		scheduler.triggerScan.mockClear();

		const res = await post(
			{ 'X-DriftWatch-Secret': WEBHOOK_SECRET },
			{ repo_full_name: 'acme/widgets', ref: 'refs/heads/main' }
		);
		expect(res.status).toBe(202);
		expect((await res.json()).data).toMatchObject({ matched: 1, triggered: 1 });
		expect(scheduler.triggerScan).toHaveBeenCalledWith(PROJECT_ID);
	});

	it('acknowledges a repo no project tracks', async () => {
		const res = await post({ 'X-DriftWatch-Secret': WEBHOOK_SECRET }, {
			repo_full_name: 'other/repo'
		});
		expect(res.status).toBe(202);
		expect((await res.json()).data).toMatchObject({ matched: 0, triggered: 0 });
	});

	it('rejects a repo_full_name that is not owner/name', async () => {
		const res = await post({ 'X-DriftWatch-Secret': WEBHOOK_SECRET }, {
			repo_full_name: 'nameonly'
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: 'INVALID_REPO' });
	});
});

describe('github oauth', () => {
	it('reports 503 when OAuth is not configured', async () => {
		const res = await fetch(base + '/api/auth/github/login', { redirect: 'manual' });
		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({ code: 'OAUTH_DISABLED' });
	});
});
