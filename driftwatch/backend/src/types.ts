/**
 * Domain types shared by the server and the agent.
 *
 * The JSON field names here are part of the wire contract: the agent pushes
 * LiveSnapshot to POST /api/agent/state, the snapshot is cached in Redis and
 * persisted to snapshots.live_state / snapshots.declared_state.
 */

export interface ContainerState {
	name: string;
	image: string;
	env: Record<string, string>;
	ports: string[];
	running: boolean;
}

export interface LiveSnapshot {
	containers: ContainerState[];
	captured_at: string;
}

export const DriftType = {
	EnvMismatch: 'env_mismatch',
	ImageStale: 'image_stale',
	PortChanged: 'port_changed',
	MissingContainer: 'missing_container',
	ExtraContainer: 'extra_container'
} as const;

export type DriftTypeValue = (typeof DriftType)[keyof typeof DriftType];

export const Severity = {
	Critical: 'critical',
	Warning: 'warning',
	Info: 'info'
} as const;

export type SeverityValue = (typeof Severity)[keyof typeof Severity];

export interface DriftEvent {
	id: string;
	type: DriftTypeValue;
	containerName: string;
	liveValue: string;
	declaredValue: string;
	severity: SeverityValue;
	detectedAt: Date;
}
