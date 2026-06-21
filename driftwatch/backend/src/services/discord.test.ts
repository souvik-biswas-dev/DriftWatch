import { describe, expect, it, vi } from 'vitest';

import { DriftType, Severity, type DriftEvent } from '../types.js';
import { colorForSeverity, DiscordClient, type DiscordPayload } from './discord.js';
import type { AnalysisResult } from './gemini.js';

function drift(
	type: string,
	containerName: string,
	severity: string
): DriftEvent {
	return {
		id: 'evt',
		type: type as DriftEvent['type'],
		containerName,
		liveValue: '',
		declaredValue: '',
		severity: severity as DriftEvent['severity'],
		detectedAt: new Date()
	};
}

/** Records the outgoing request and replies with the given status. */
function captureFetch(status = 204, body = '') {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = vi.fn(async (url: unknown, init: unknown) => {
		calls.push({ url: String(url), init: init as RequestInit });
		// A 204 is a null-body status; an empty string still counts as a body.
		return new Response(body || null, { status });
	});
	return { calls, impl: impl as unknown as typeof fetch };
}

describe('DiscordClient', () => {
	it('posts the expected embed', async () => {
		const { calls, impl } = captureFetch();
		const c = new DiscordClient('https://discord.test/webhook', { fetchImpl: impl });

		const result: AnalysisResult = {
			severity: Severity.Critical,
			summary: 'Web container is gone in prod',
			fixCommand: 'docker compose up -d web',
			explanation: 'The web service is declared but not running.',
			driftBreakdown: []
		};
		const drifts = [
			drift(DriftType.MissingContainer, 'web', Severity.Critical),
			drift(DriftType.EnvMismatch, 'web', Severity.Critical),
			drift(DriftType.ImageStale, 'api', Severity.Warning)
		];

		await c.sendDriftAlert('acme-prod', result, drifts);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.init.method).toBe('POST');
		expect(
			(calls[0]!.init.headers as Record<string, string>)['Content-Type']
		).toBe('application/json');

		const payload = JSON.parse(calls[0]!.init.body as string) as DiscordPayload;
		expect(payload.embeds).toHaveLength(1);

		const e = payload.embeds[0]!;
		expect(e.title).toBe('⚠️ Drift Detected — acme-prod');
		expect(e.color).toBe(15158332);
		expect(e.fields).toHaveLength(5);

		const byName = new Map(e.fields.map((f) => [f.name, f]));
		expect(byName.get('Severity')).toMatchObject({ value: 'critical', inline: true });
		// web + api are the two unique containers.
		expect(byName.get('Containers Affected')).toMatchObject({
			value: '2',
			inline: true
		});
		expect(byName.get('Summary')!.value).toBe('Web container is gone in prod');
		expect(byName.get('Summary')!.inline).toBeUndefined();
		expect(byName.get('Fix Command')!.value).toContain('```bash');
		expect(byName.get('Fix Command')!.value).toContain('docker compose up -d web');
		expect(byName.get('Explanation')!.value).toBe(
			'The web service is declared but not running.'
		);

		expect(e.footer.text).toContain('DriftWatch');
		expect(e.footer.text).toContain('detected at');
		expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
	});

	it('maps severity to colour', () => {
		expect(colorForSeverity(Severity.Critical)).toBe(15158332);
		expect(colorForSeverity(Severity.Warning)).toBe(16776960);
		expect(colorForSeverity(Severity.Info)).toBe(3447003);
		expect(colorForSeverity('nonsense')).toBe(3447003);
	});

	it('throws on a non-OK status, including the response body', async () => {
		const { impl } = captureFetch(400, '{"message":"invalid embed"}');
		const c = new DiscordClient('https://discord.test/webhook', { fetchImpl: impl });

		await expect(
			c.sendDriftAlert('p', {
				severity: Severity.Info,
				summary: '',
				fixCommand: 'noop',
				explanation: '',
				driftBreakdown: []
			}, [])
		).rejects.toThrow(/400.*invalid embed/s);
	});

	it('throws when the analysis is null', async () => {
		const c = new DiscordClient('https://discord.test/webhook');
		await expect(c.sendDriftAlert('p', null, [])).rejects.toThrow(/nil/);
	});

	it('is a no-op when no webhook is configured', async () => {
		const { calls, impl } = captureFetch();
		const c = new DiscordClient('', { fetchImpl: impl });

		await expect(c.sendDriftAlert('p', null, [])).resolves.toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it('enforces a 30 minute alert cooldown', () => {
		const c = new DiscordClient('https://discord.test/webhook');
		const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

		expect(c.shouldAlert('p', null)).toBe(true);
		expect(c.shouldAlert('p', minutesAgo(5))).toBe(false);
		expect(c.shouldAlert('p', minutesAgo(29))).toBe(false);
		expect(c.shouldAlert('p', minutesAgo(31))).toBe(true);
	});
});
