import { randomUUID } from 'node:crypto';

import {
	DriftType,
	Severity,
	type ContainerState,
	type DriftEvent,
	type LiveSnapshot,
	type SeverityValue
} from '../types.js';

/**
 * diff compares the live and declared snapshots and returns every drift event
 * detected. The output ordering is stable: containers are walked in
 * alphabetical order, and per-container env keys are walked in sorted order.
 */
export function diff(
	live: LiveSnapshot | null | undefined,
	declared: LiveSnapshot | null | undefined
): DriftEvent[] {
	const liveByName = indexByName(live);
	const declaredByName = indexByName(declared);
	const now = new Date();

	const events: DriftEvent[] = [];

	for (const name of unionNames(liveByName, declaredByName)) {
		const liveC = liveByName.get(name);
		const decC = declaredByName.get(name);

		if (decC && !liveC) {
			events.push({
				id: randomUUID(),
				type: DriftType.MissingContainer,
				containerName: name,
				liveValue: '',
				declaredValue: decC.image,
				severity: Severity.Critical,
				detectedAt: now
			});
			continue;
		}
		if (liveC && !decC) {
			events.push({
				id: randomUUID(),
				type: DriftType.ExtraContainer,
				containerName: name,
				liveValue: liveC.image,
				declaredValue: '',
				severity: Severity.Info,
				detectedAt: now
			});
			continue;
		}
		if (!liveC || !decC) continue; // unreachable; narrows the types below

		// Image tag — split on the last ":" and compare the tag half.
		if (tagOf(liveC.image) !== tagOf(decC.image)) {
			events.push({
				id: randomUUID(),
				type: DriftType.ImageStale,
				containerName: name,
				liveValue: liveC.image,
				declaredValue: decC.image,
				severity: Severity.Warning,
				detectedAt: now
			});
		}

		// Env — for every declared key, flag if live is missing it or differs.
		for (const k of Object.keys(decC.env).sort()) {
			const decVal = decC.env[k] ?? '';
			const liveVal = liveC.env[k];
			if (liveVal === undefined || liveVal !== decVal) {
				events.push({
					id: randomUUID(),
					type: DriftType.EnvMismatch,
					containerName: name,
					liveValue: liveVal ?? '',
					declaredValue: decVal,
					severity: severityForEnvKey(k),
					detectedAt: now
				});
			}
		}

		// Ports — the declared set must be a subset of the live set.
		const liveSet = new Set(liveC.ports);
		if (decC.ports.some((p) => !liveSet.has(p))) {
			events.push({
				id: randomUUID(),
				type: DriftType.PortChanged,
				containerName: name,
				liveValue: liveC.ports.join(','),
				declaredValue: decC.ports.join(','),
				severity: Severity.Warning,
				detectedAt: now
			});
		}
	}

	return events;
}

function indexByName(s: LiveSnapshot | null | undefined): Map<string, ContainerState> {
	const out = new Map<string, ContainerState>();
	if (!s?.containers) return out;
	for (const c of s.containers) out.set(c.name, c);
	return out;
}

function unionNames(
	a: Map<string, ContainerState>,
	b: Map<string, ContainerState>
): string[] {
	return [...new Set([...a.keys(), ...b.keys()])].sort();
}

/**
 * tagOf returns the tag portion of a docker image reference. It splits on the
 * last ":" so registries with a port ("registry:5000/img:tag") work, and falls
 * back to "latest" when no tag is present.
 */
export function tagOf(image: string): string {
	const idx = image.lastIndexOf(':');
	if (idx === -1) return 'latest';
	return image.slice(idx + 1);
}

const CRITICAL_ENV_TRIGGERS = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'DATABASE', 'DB'];

export function severityForEnvKey(key: string): SeverityValue {
	const up = key.toUpperCase();
	return CRITICAL_ENV_TRIGGERS.some((t) => up.includes(t))
		? Severity.Critical
		: Severity.Warning;
}
