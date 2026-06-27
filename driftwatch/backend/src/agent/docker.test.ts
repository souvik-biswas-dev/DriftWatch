import { describe, expect, it } from 'vitest';

import { DockerClient, parseDockerHost, parseEnvList, type DockerApi } from './docker.js';

/** Minimal stand-in for the dockerode API surface the client uses. */
function fakeApi(
	containers: unknown[],
	envById: Record<string, string[]> = {}
): DockerApi {
	return {
		listContainers: async () => containers as never,
		getContainer: (id: string) => ({
			inspect: async () => {
				const env = envById[id];
				if (!env) throw new Error('no such container');
				return { Config: { Env: env } } as never;
			}
		})
	};
}

describe('DockerClient.fetchLiveState', () => {
	it('shapes container state', async () => {
		const api = fakeApi(
			[
				{
					Id: 'web-id',
					Names: ['/web'],
					Image: 'nginx:1.25',
					State: 'running',
					Ports: [{ PublicPort: 8080, PrivatePort: 80 }]
				},
				{
					Id: 'worker-id',
					Names: ['/worker'],
					Image: 'redis:7',
					State: 'exited',
					Ports: []
				}
			],
			{
				'web-id': ['APP_ENV=production', 'VERSION=1.0.0'],
				'worker-id': []
			}
		);

		const snap = await new DockerClient(api).fetchLiveState();

		expect(Number.isNaN(Date.parse(snap.captured_at))).toBe(false);
		expect(snap.containers).toHaveLength(2);

		const web = snap.containers[0]!;
		expect(web.name).toBe('web');
		expect(web.image).toBe('nginx:1.25');
		expect(web.running).toBe(true);
		expect(web.env.APP_ENV).toBe('production');
		expect(web.env.VERSION).toBe('1.0.0');
		expect(web.ports).toEqual(['8080:80']);

		const worker = snap.containers[1]!;
		expect(worker.name).toBe('worker');
		expect(worker.running).toBe(false);
		expect(worker.ports).toEqual([]);
		expect(worker.env).toEqual({});
	});

	it('reports an unpublished port as host port 0', async () => {
		const api = fakeApi(
			[
				{
					Id: 'db-id',
					Names: ['/db'],
					Image: 'postgres:16',
					State: 'running',
					Ports: [{ PrivatePort: 5432 }]
				}
			],
			{ 'db-id': [] }
		);

		const snap = await new DockerClient(api).fetchLiveState();
		expect(snap.containers[0]!.ports).toEqual(['0:5432']);
	});

	it('survives a container disappearing between list and inspect', async () => {
		const api = fakeApi([
			{ Id: 'gone', Names: ['/gone'], Image: 'alpine', State: 'running', Ports: [] }
		]);

		const snap = await new DockerClient(api).fetchLiveState();
		expect(snap.containers[0]!.env).toEqual({});
	});
});

describe('parseEnvList', () => {
	it('splits on the first "=" only', () => {
		expect(parseEnvList(['A=1', 'URL=postgres://u:p@h/db', 'BARE'])).toEqual({
			A: '1',
			URL: 'postgres://u:p@h/db',
			BARE: ''
		});
	});
});

describe('parseDockerHost', () => {
	it('understands the DOCKER_HOST forms', () => {
		expect(parseDockerHost('unix:///var/run/docker.sock')).toEqual({
			socketPath: '/var/run/docker.sock'
		});
		expect(parseDockerHost('tcp://10.0.0.5:2375')).toEqual({
			host: '10.0.0.5',
			port: 2375,
			protocol: 'http'
		});
		expect(parseDockerHost('https://docker.internal:2376')).toEqual({
			host: 'docker.internal',
			port: 2376,
			protocol: 'https'
		});
	});
});
