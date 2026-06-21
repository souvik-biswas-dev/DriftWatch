import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { GitHubClient, normalizeEnv, normalizePorts, parseCompose } from './github.js';

const SAMPLE_COMPOSE = `services:
  web:
    image: nginx:1.25
    environment:
      - APP_ENV=production
      - VERSION=1.0.0
    ports:
      - "8080:80"
  api:
    image: myapp:v2
    environment:
      DEBUG: "true"
      LOG_LEVEL: info
    ports:
      - "3000:3000"
`;

type Handler = (
	req: { url: string },
	res: { statusCode: number; end(body: string): void }
) => void;

let server: Server | undefined;

async function newTestClient(handler: Handler): Promise<GitHubClient> {
	server = createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		handler({ url: req.url ?? '' }, res as never);
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const { port } = server!.address() as AddressInfo;
	return new GitHubClient('', { baseUrl: `http://127.0.0.1:${port}` });
}

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
	}
});

describe('fetchDeclaredConfig', () => {
	it('parses both env shapes', async () => {
		let seenUrl = '';
		const client = await newTestClient((req, res) => {
			seenUrl = req.url;
			res.end(
				JSON.stringify({
					type: 'file',
					encoding: 'base64',
					name: 'docker-compose.yml',
					path: 'docker-compose.yml',
					content: Buffer.from(SAMPLE_COMPOSE).toString('base64'),
					sha: 'deadbeef',
					size: SAMPLE_COMPOSE.length
				})
			);
		});

		const snap = await client.fetchDeclaredConfig('acme', 'widgets', 'main');

		expect(seenUrl).toContain('/repos/acme/widgets/contents/docker-compose.yml');
		expect(seenUrl).toContain('ref=main');
		expect(snap.containers).toHaveLength(2);

		const byName = new Map(snap.containers.map((c) => [c.name, c]));

		const web = byName.get('web')!;
		expect(web.image).toBe('nginx:1.25');
		expect(web.running).toBe(true);
		expect(web.env.APP_ENV).toBe('production');
		expect(web.env.VERSION).toBe('1.0.0');
		expect(web.ports).toEqual(['8080:80']);

		const api = byName.get('api')!;
		expect(api.image).toBe('myapp:v2');
		expect(api.env.DEBUG).toBe('true');
		expect(api.env.LOG_LEVEL).toBe('info');
		expect(api.ports).toEqual(['3000:3000']);
	});

	it('reports a missing compose file clearly', async () => {
		const client = await newTestClient((_req, res) => {
			res.statusCode = 404;
			res.end(JSON.stringify({ message: 'Not Found' }));
		});

		await expect(
			client.fetchDeclaredConfig('acme', 'widgets', 'main')
		).rejects.toThrow('docker-compose.yml not found in acme/widgets@main');
	});

	it('rejects a directory where a file was expected', async () => {
		const client = await newTestClient((_req, res) => {
			res.end(JSON.stringify([{ type: 'file', name: 'a.yml' }]));
		});

		await expect(
			client.fetchDeclaredConfig('acme', 'widgets', 'main')
		).rejects.toThrow(/directory, not a file/);
	});
});

describe('normalizeEnv', () => {
	it('handles the list shape', () => {
		expect(normalizeEnv(['APP_ENV=prod', 'DEBUG=true', 'BARE'])).toEqual({
			APP_ENV: 'prod',
			DEBUG: 'true',
			BARE: ''
		});
	});

	it('handles the map shape, stringifying scalars', () => {
		expect(normalizeEnv({ DEBUG: true, PORT: 8080, NAME: 'api', EMPTY: null })).toEqual(
			{ DEBUG: 'true', PORT: '8080', NAME: 'api', EMPTY: '' }
		);
	});

	it('handles a missing environment block', () => {
		expect(normalizeEnv(undefined)).toEqual({});
		expect(normalizeEnv(null)).toEqual({});
	});

	it('keeps the value after the first "=" intact', () => {
		expect(normalizeEnv(['DATABASE_URL=postgres://u:p@host:5432/db'])).toEqual({
			DATABASE_URL: 'postgres://u:p@host:5432/db'
		});
	});
});

describe('normalizePorts', () => {
	it('coerces the shapes compose allows', () => {
		expect(normalizePorts(['8080:80'])).toEqual(['8080:80']);
		expect(normalizePorts([3000])).toEqual(['3000']);
		// An unquoted `- 8080:80` is read by YAML as a map.
		expect(normalizePorts([{ 8080: 80 }])).toEqual(['8080:80']);
		expect(normalizePorts([{ target: 80, published: 8080 }])).toEqual(['8080:80']);
		expect(normalizePorts(undefined)).toEqual([]);
	});
});

describe('parseCompose', () => {
	it('returns an empty snapshot for a compose file with no services', () => {
		const snap = parseCompose('version: "3"\n');
		expect(snap.containers).toEqual([]);
		expect(Number.isNaN(Date.parse(snap.captured_at))).toBe(false);
	});
});
