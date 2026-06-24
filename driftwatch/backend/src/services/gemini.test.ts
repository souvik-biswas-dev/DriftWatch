import { describe, expect, it, vi } from 'vitest';

import { DriftType, Severity, type DriftEvent } from '../types.js';
import { GeminiClient, stripFences } from './gemini.js';

const VALID_MODEL_JSON = `{
  "severity": "critical",
  "summary": "The web container is missing in production",
  "fixCommand": "docker compose up -d web",
  "explanation": "The web service declared in docker-compose.yml is not present on the host.",
  "driftBreakdown": [
    {
      "containerName": "web",
      "driftType": "missing_container",
      "fixStep": "Bring the web service up with docker compose"
    }
  ]
}`;

function wrapInGeminiResponse(text: string): string {
	return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

/** Replies with each queued response in turn, recording every request. */
function scriptedFetch(responses: (() => Response)[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	let i = 0;
	const impl = vi.fn(async (url: unknown, init: unknown) => {
		calls.push({ url: String(url), init: init as RequestInit });
		const make = responses[Math.min(i++, responses.length - 1)]!;
		return make();
	});
	return { calls, impl: impl as unknown as typeof fetch };
}

function client(impl: typeof fetch) {
	return new GeminiClient('fake-key', {
		baseUrl: 'https://gemini.test/generate',
		retryDelayMs: 10,
		fetchImpl: impl
	});
}

const sampleDrifts: DriftEvent[] = [
	{
		id: 'evt-1',
		type: DriftType.MissingContainer,
		containerName: 'web',
		liveValue: '',
		declaredValue: 'nginx:1.25',
		severity: Severity.Critical,
		detectedAt: new Date()
	}
];

describe('GeminiClient.analyze', () => {
	it('parses a valid response, stripping code fences', async () => {
		const wrapped = '```json\n' + VALID_MODEL_JSON + '\n```';
		const { calls, impl } = scriptedFetch([
			() => new Response(wrapInGeminiResponse(wrapped), { status: 200 })
		]);

		const result = await client(impl).analyze(sampleDrifts);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toContain('key=fake-key');
		expect(calls[0]!.init.method).toBe('POST');
		expect(
			(calls[0]!.init.headers as Record<string, string>)['Content-Type']
		).toBe('application/json');
		const body = calls[0]!.init.body as string;
		expect(body).toContain('"contents"');
		expect(body).toContain('missing_container');

		expect(result.severity).toBe('critical');
		expect(result.summary).toContain('web container');
		expect(result.fixCommand).toBe('docker compose up -d web');
		expect(result.explanation).toBeTruthy();
		expect(result.driftBreakdown).toHaveLength(1);
		expect(result.driftBreakdown[0]).toMatchObject({
			containerName: 'web',
			driftType: 'missing_container'
		});
		expect(result.driftBreakdown[0]!.fixStep).toBeTruthy();
	});

	it('treats an empty fixCommand as an incomplete analysis', async () => {
		const incomplete = JSON.stringify({
			severity: 'warning',
			summary: 'minor drift',
			fixCommand: '',
			explanation: 'n/a',
			driftBreakdown: []
		});
		const { impl } = scriptedFetch([
			() => new Response(wrapInGeminiResponse(incomplete), { status: 200 })
		]);

		await expect(client(impl).analyze([])).rejects.toThrow(/incomplete analysis/);
	});

	it('retries once on error', async () => {
		const { calls, impl } = scriptedFetch([
			() => new Response('boom', { status: 500 }),
			() => new Response(wrapInGeminiResponse(VALID_MODEL_JSON), { status: 200 })
		]);

		const result = await client(impl).analyze([]);

		expect(calls).toHaveLength(2);
		expect(result.fixCommand).toBe('docker compose up -d web');
	});

	it('gives up after the second failure', async () => {
		const { calls, impl } = scriptedFetch([
			() => new Response('boom', { status: 500 })
		]);

		await expect(client(impl).analyze([])).rejects.toThrow(/failed after retry/);
		expect(calls).toHaveLength(2);
	});

	it('errors when the model returns no candidates', async () => {
		const { impl } = scriptedFetch([
			() => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
		]);

		await expect(client(impl).analyze([])).rejects.toThrow(/no candidates/);
	});
});

describe('stripFences', () => {
	const table: [string, string][] = [
		['```json\n{"a":1}\n```', '{"a":1}'],
		['```\n{"a":1}\n```', '{"a":1}'],
		['{"a":1}', '{"a":1}'],
		['   ```json\n{"a":1}\n```   ', '{"a":1}']
	];
	for (const [input, want] of table) {
		it(JSON.stringify(input), () => expect(stripFences(input)).toBe(want));
	}
});
