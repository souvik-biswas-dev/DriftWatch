import Docker from 'dockerode';
import type { ContainerInfo, ContainerInspectInfo, DockerOptions } from 'dockerode';

import type { ContainerState, LiveSnapshot } from '../types.js';

/** The subset of the dockerode API this client depends on; tests inject a fake. */
export interface DockerApi {
	listContainers(opts: { all: boolean }): Promise<ContainerInfo[]>;
	getContainer(id: string): { inspect(): Promise<ContainerInspectInfo> };
}

/** How many `docker inspect` calls to run at once when reading env vars. */
const INSPECT_CONCURRENCY = 8;

export class DockerClient {
	private readonly api: DockerApi;

	constructor(api: DockerApi) {
		this.api = api;
	}

	/**
	 * Connects to a Docker endpoint. Accepts the DOCKER_HOST forms the Go agent
	 * did: unix:///var/run/docker.sock, tcp://host:2375, http(s)://host:port.
	 */
	static connect(dockerHost: string): DockerClient {
		return new DockerClient(new Docker(parseDockerHost(dockerHost)));
	}

	async fetchLiveState(): Promise<LiveSnapshot> {
		const containers = await this.api.listContainers({ all: true });

		const states: ContainerState[] = new Array<ContainerState>(containers.length);
		let next = 0;

		const worker = async (): Promise<void> => {
			for (let i = next++; i < containers.length; i = next++) {
				states[i] = await this.toContainerState(containers[i]!);
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(INSPECT_CONCURRENCY, containers.length) }, worker)
		);

		return { containers: states, captured_at: new Date().toISOString() };
	}

	private async toContainerState(c: ContainerInfo): Promise<ContainerState> {
		const name = c.Names?.[0]?.replace(/^\//, '') ?? '';

		const ports = (c.Ports ?? []).map(
			(p) => `${p.PublicPort ?? 0}:${p.PrivatePort}`
		);

		return {
			name,
			image: c.Image,
			env: await this.readEnv(c.Id),
			ports,
			running: c.State === 'running'
		};
	}

	/**
	 * Reads a container's environment variables.
	 *
	 * The list endpoint doesn't carry them, so this inspects each container —
	 * without it there is nothing to compare against the `environment:` block in
	 * docker-compose.yml, which is what the env_mismatch drift type is for.
	 * A container that vanishes between list and inspect yields an empty map
	 * rather than failing the whole snapshot.
	 */
	private async readEnv(id: string): Promise<Record<string, string>> {
		let info: ContainerInspectInfo;
		try {
			info = await this.api.getContainer(id).inspect();
		} catch {
			return {};
		}
		return parseEnvList(info.Config?.Env ?? []);
	}
}

/** Turns docker's ["KEY=value", ...] into a map. */
export function parseEnvList(list: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of list) {
		const idx = entry.indexOf('=');
		if (idx === -1) out[entry] = '';
		else out[entry.slice(0, idx)] = entry.slice(idx + 1);
	}
	return out;
}

export function parseDockerHost(dockerHost: string): DockerOptions {
	if (dockerHost.startsWith('unix://')) {
		return { socketPath: dockerHost.slice('unix://'.length) };
	}
	if (dockerHost.startsWith('npipe://')) {
		return { socketPath: dockerHost.slice('npipe://'.length) };
	}

	const url = new URL(dockerHost);
	const protocol = url.protocol === 'https:' ? 'https' : 'http';
	return {
		host: url.hostname,
		port: url.port ? Number(url.port) : protocol === 'https' ? 2376 : 2375,
		protocol
	};
}
