/**
 * The DriftWatch agent. It runs on the user's own host (next to their Docker
 * daemon), reads the live container state locally, and pushes it to the
 * DriftWatch backend over HTTPS. The backend never connects to the user's
 * Docker host, so this works behind NAT/firewalls and keeps the daemon private.
 *
 * Configuration (environment variables):
 *
 *   DRIFTWATCH_URL        required  base URL of the backend, e.g. https://driftwatch.example.com
 *   DRIFTWATCH_AGENT_KEY  required  the agent key shown once when the project was created
 *   DOCKER_HOST           optional  Docker endpoint (default unix:///var/run/docker.sock)
 *   SCAN_INTERVAL         optional  how often to push state (default 60s), e.g. 30s, 2m
 */
import { AGENT_KEY_HEADER } from '../api/agentKey.js';
import { logger } from '../logger.js';
import type { LiveSnapshot } from '../types.js';
import { DockerClient } from './docker.js';

const PUSH_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
	const backendURL = (process.env.DRIFTWATCH_URL ?? '').replace(/\/+$/, '');
	const agentKey = process.env.DRIFTWATCH_AGENT_KEY ?? '';
	const dockerHost = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';

	if (backendURL === '') throw new Error('DRIFTWATCH_URL is required');
	if (agentKey === '') throw new Error('DRIFTWATCH_AGENT_KEY is required');

	const intervalMs = parseDuration(process.env.SCAN_INTERVAL ?? '60s');
	const docker = DockerClient.connect(dockerHost);
	const endpoint = backendURL + '/api/agent/state';

	logger.info('driftwatch agent started', {
		backend: backendURL,
		docker_host: dockerHost,
		interval: `${intervalMs / 1000}s`
	});

	// Push once immediately, then on every tick.
	await pushOnce(docker, endpoint, agentKey);
	setInterval(() => {
		void pushOnce(docker, endpoint, agentKey);
	}, intervalMs);
}

async function pushOnce(
	docker: DockerClient,
	endpoint: string,
	agentKey: string
): Promise<void> {
	let snapshot: LiveSnapshot;
	try {
		snapshot = await docker.fetchLiveState();
	} catch (err) {
		logger.error('read docker state', { error: err });
		return;
	}

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				[AGENT_KEY_HEADER]: agentKey
			},
			body: JSON.stringify(snapshot),
			signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
		});
	} catch (err) {
		logger.error('push state', { error: err });
		return;
	}

	if (res.status >= 300) {
		const body = await res.text().catch(() => '');
		logger.error('backend rejected push', {
			status: res.status,
			body: body.slice(0, 512).trim()
		});
		return;
	}

	logger.info('pushed live state', {
		containers: snapshot.containers.length,
		status: res.status
	});
}

/** Parses Go-style durations ("30s", "2m", "1h"); a bare number means seconds. */
export function parseDuration(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
	if (!match) throw new Error(`invalid SCAN_INTERVAL "${value}"`);

	const amount = Number(match[1]);
	switch (match[2]) {
		case 'ms':
			return amount;
		case 'm':
			return amount * 60_000;
		case 'h':
			return amount * 3_600_000;
		default:
			return amount * 1000;
	}
}

main().catch((err: Error) => {
	logger.error('agent fatal', { error: err });
	process.exit(1);
});
