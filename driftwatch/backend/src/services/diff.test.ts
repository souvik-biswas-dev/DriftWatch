import { describe, expect, it } from 'vitest';

import { DriftType, Severity, type ContainerState, type LiveSnapshot } from '../types.js';
import { diff, severityForEnvKey, tagOf } from './diff.js';

/** The projection asserted on; id and detectedAt are checked separately. */
interface ExpectDrift {
	type: string;
	containerName: string;
	severity: string;
	liveValue: string;
	declaredValue: string;
}

function snap(...containers: ContainerState[]): LiveSnapshot {
	return { containers, captured_at: new Date().toISOString() };
}

function ctr(
	name: string,
	image: string,
	env: Record<string, string> = {},
	ports: string[] = []
): ContainerState {
	return { name, image, env, ports, running: true };
}

const cases: {
	name: string;
	live: LiveSnapshot | null;
	declared: LiveSnapshot | null;
	want: ExpectDrift[];
}[] = [
	{
		name: 'no drift when snapshots match',
		live: snap(ctr('web', 'nginx:1.25')),
		declared: snap(ctr('web', 'nginx:1.25')),
		want: []
	},

	// MissingContainer
	{
		name: 'missing container: declared web, live empty',
		live: snap(),
		declared: snap(ctr('web', 'nginx:1.25')),
		want: [
			{
				type: DriftType.MissingContainer,
				containerName: 'web',
				severity: Severity.Critical,
				liveValue: '',
				declaredValue: 'nginx:1.25'
			}
		]
	},
	{
		name: 'missing container: api absent while web present',
		live: snap(ctr('web', 'nginx:1.25')),
		declared: snap(ctr('web', 'nginx:1.25'), ctr('api', 'myapp:v2')),
		want: [
			{
				type: DriftType.MissingContainer,
				containerName: 'api',
				severity: Severity.Critical,
				liveValue: '',
				declaredValue: 'myapp:v2'
			}
		]
	},

	// ExtraContainer
	{
		name: 'extra container: live has web, declared empty',
		live: snap(ctr('web', 'nginx:1.25')),
		declared: snap(),
		want: [
			{
				type: DriftType.ExtraContainer,
				containerName: 'web',
				severity: Severity.Info,
				liveValue: 'nginx:1.25',
				declaredValue: ''
			}
		]
	},
	{
		name: 'extra container: debug running but not declared',
		live: snap(ctr('web', 'nginx:1.25'), ctr('debug', 'busybox:latest')),
		declared: snap(ctr('web', 'nginx:1.25')),
		want: [
			{
				type: DriftType.ExtraContainer,
				containerName: 'debug',
				severity: Severity.Info,
				liveValue: 'busybox:latest',
				declaredValue: ''
			}
		]
	},

	// ImageStale
	{
		name: 'image stale: nginx tag bumped',
		live: snap(ctr('web', 'nginx:1.25')),
		declared: snap(ctr('web', 'nginx:1.26')),
		want: [
			{
				type: DriftType.ImageStale,
				containerName: 'web',
				severity: Severity.Warning,
				liveValue: 'nginx:1.25',
				declaredValue: 'nginx:1.26'
			}
		]
	},
	{
		name: 'image stale: api v1 in live, v2 declared',
		live: snap(ctr('api', 'myapp:v1')),
		declared: snap(ctr('api', 'myapp:v2')),
		want: [
			{
				type: DriftType.ImageStale,
				containerName: 'api',
				severity: Severity.Warning,
				liveValue: 'myapp:v1',
				declaredValue: 'myapp:v2'
			}
		]
	},

	// EnvMismatch
	{
		name: 'env mismatch (warning): APP_ENV drift',
		live: snap(ctr('web', 'nginx:1.25', { APP_ENV: 'dev' })),
		declared: snap(ctr('web', 'nginx:1.25', { APP_ENV: 'prod' })),
		want: [
			{
				type: DriftType.EnvMismatch,
				containerName: 'web',
				severity: Severity.Warning,
				liveValue: 'dev',
				declaredValue: 'prod'
			}
		]
	},
	{
		name: 'env mismatch (critical): API_KEY rotated in declared',
		live: snap(ctr('api', 'myapp:v1', { API_KEY: 'xyz' })),
		declared: snap(ctr('api', 'myapp:v1', { API_KEY: 'abc' })),
		want: [
			{
				type: DriftType.EnvMismatch,
				containerName: 'api',
				severity: Severity.Critical,
				liveValue: 'xyz',
				declaredValue: 'abc'
			}
		]
	},
	{
		name: 'env mismatch (critical): declared key missing on live',
		live: snap(ctr('api', 'myapp:v1', {})),
		declared: snap(ctr('api', 'myapp:v1', { DB_PASSWORD: 'hunter2' })),
		want: [
			{
				type: DriftType.EnvMismatch,
				containerName: 'api',
				severity: Severity.Critical,
				liveValue: '',
				declaredValue: 'hunter2'
			}
		]
	},

	// PortChanged
	{
		name: 'port changed: host port differs',
		live: snap(ctr('web', 'nginx:1.25', {}, ['9090:80'])),
		declared: snap(ctr('web', 'nginx:1.25', {}, ['8080:80'])),
		want: [
			{
				type: DriftType.PortChanged,
				containerName: 'web',
				severity: Severity.Warning,
				liveValue: '9090:80',
				declaredValue: '8080:80'
			}
		]
	},
	{
		name: 'port changed: declared exposes extra port not live',
		live: snap(ctr('api', 'myapp:v1', {}, ['3000:3000'])),
		declared: snap(ctr('api', 'myapp:v1', {}, ['3000:3000', '9000:9000'])),
		want: [
			{
				type: DriftType.PortChanged,
				containerName: 'api',
				severity: Severity.Warning,
				liveValue: '3000:3000',
				declaredValue: '3000:3000,9000:9000'
			}
		]
	},

	// Multiple drifts on one container
	{
		name: 'compound: image stale + env mismatch on same container',
		live: snap(ctr('web', 'nginx:1.25', { APP_ENV: 'dev' }, ['8080:80'])),
		declared: snap(ctr('web', 'nginx:1.26', { APP_ENV: 'prod' }, ['8080:80'])),
		want: [
			{
				type: DriftType.ImageStale,
				containerName: 'web',
				severity: Severity.Warning,
				liveValue: 'nginx:1.25',
				declaredValue: 'nginx:1.26'
			},
			{
				type: DriftType.EnvMismatch,
				containerName: 'web',
				severity: Severity.Warning,
				liveValue: 'dev',
				declaredValue: 'prod'
			}
		]
	}
];

describe('diff', () => {
	for (const tc of cases) {
		it(tc.name, () => {
			const got = diff(tc.live, tc.declared);
			expect(got).toHaveLength(tc.want.length);

			const actual: ExpectDrift[] = got.map((e) => {
				expect(e.id).toBeTruthy();
				expect(e.detectedAt.getTime()).toBeGreaterThan(0);
				return {
					type: e.type,
					containerName: e.containerName,
					severity: e.severity,
					liveValue: e.liveValue,
					declaredValue: e.declaredValue
				};
			});

			expect(actual).toEqual(expect.arrayContaining(tc.want));
		});
	}

	it('handles null snapshots', () => {
		expect(diff(null, null)).toHaveLength(0);

		// Only declared: every container is missing.
		let got = diff(null, snap(ctr('web', 'nginx:1.25')));
		expect(got).toHaveLength(1);
		expect(got[0]!.type).toBe(DriftType.MissingContainer);

		// Only live: every container is extra.
		got = diff(snap(ctr('web', 'nginx:1.25')), null);
		expect(got).toHaveLength(1);
		expect(got[0]!.type).toBe(DriftType.ExtraContainer);
	});
});

describe('severityForEnvKey', () => {
	const table: [string, string][] = [
		['DB_PASSWORD', Severity.Critical],
		['db_password', Severity.Critical],
		['API_SECRET', Severity.Critical],
		['API_KEY', Severity.Critical],
		['GITHUB_TOKEN', Severity.Critical],
		['DATABASE_URL', Severity.Critical],
		['DB_HOST', Severity.Critical],
		['APP_ENV', Severity.Warning],
		['LOG_LEVEL', Severity.Warning],
		['DEBUG', Severity.Warning]
	];

	for (const [key, want] of table) {
		it(key, () => expect(severityForEnvKey(key)).toBe(want));
	}
});

describe('tagOf', () => {
	it('splits on the last colon so registry ports survive', () => {
		expect(tagOf('nginx:1.25')).toBe('1.25');
		expect(tagOf('registry:5000/img:v2')).toBe('v2');
		expect(tagOf('nginx')).toBe('latest');
	});
});
