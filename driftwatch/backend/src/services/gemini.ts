import { logger } from '../logger.js';
import type { DriftEvent } from '../types.js';

/**
 * defaultModel is on the Gemini free tier. Override with GEMINI_MODEL, e.g.
 * gemini-2.5-flash-lite, gemini-2.0-flash. gemini-1.5-* is being retired.
 */
const DEFAULT_MODEL = 'gemini-2.5-flash';
const BASE_URL_TEMPLATE =
	'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent';

export interface DriftSummary {
	containerName: string;
	driftType: string;
	fixStep: string;
}

export interface AnalysisResult {
	severity: string;
	summary: string;
	fixCommand: string;
	explanation: string;
	driftBreakdown: DriftSummary[];
}

export interface GeminiClientOptions {
	model?: string;
	/** Full endpoint override. Only used by tests. */
	baseUrl?: string;
	retryDelayMs?: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export interface Analyzer {
	analyze(drifts: DriftEvent[]): Promise<AnalysisResult>;
}

export class GeminiClient implements Analyzer {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly retryDelayMs: number;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(apiKey: string, opts: GeminiClientOptions = {}) {
		const model = opts.model || DEFAULT_MODEL;
		this.apiKey = apiKey;
		this.baseUrl = opts.baseUrl ?? BASE_URL_TEMPLATE.replace('%s', model);
		this.retryDelayMs = opts.retryDelayMs ?? 2000;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	/**
	 * Sends the drift events to Gemini and returns the parsed AnalysisResult.
	 * On any failure it waits retryDelayMs and tries once more.
	 */
	async analyze(drifts: DriftEvent[]): Promise<AnalysisResult> {
		const prompt = buildPrompt(drifts);

		let lastErr: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) {
				logger.warn('gemini: retrying after error', {
					previous_error: lastErr,
					delay_ms: this.retryDelayMs
				});
				await sleep(this.retryDelayMs);
			}
			try {
				return await this.callOnce(prompt);
			} catch (err) {
				lastErr = err;
			}
		}
		throw new Error(
			`gemini: analyze failed after retry: ${(lastErr as Error)?.message ?? lastErr}`
		);
	}

	private async callOnce(prompt: string): Promise<AnalysisResult> {
		const endpoint = `${this.baseUrl}?key=${encodeURIComponent(this.apiKey)}`;

		const res = await this.fetchImpl(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
			signal: AbortSignal.timeout(this.timeoutMs)
		});

		const body = await res.text();
		if (!res.ok) {
			throw new Error(`gemini HTTP ${res.status}: ${body}`);
		}

		let parsed: {
			candidates?: { content?: { parts?: { text?: string }[] } }[];
		};
		try {
			parsed = JSON.parse(body);
		} catch (err) {
			throw new Error(`decode response: ${(err as Error).message}`);
		}

		const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
		if (text === undefined) {
			throw new Error('gemini returned no candidates');
		}

		const cleaned = stripFences(text);
		let result: AnalysisResult;
		try {
			result = JSON.parse(cleaned) as AnalysisResult;
		} catch (err) {
			throw new Error(`parse model JSON: ${(err as Error).message} (body: ${cleaned})`);
		}
		if (!result.fixCommand) {
			throw new Error('gemini returned incomplete analysis');
		}
		return result;
	}
}

/**
 * stripFences removes a leading ```json (or plain ```) and trailing ``` fence
 * from a model response, since Gemini occasionally ignores the "no markdown"
 * instruction.
 */
export function stripFences(s: string): string {
	let out = s.trim();
	if (out.startsWith('```json')) out = out.slice('```json'.length);
	else if (out.startsWith('```')) out = out.slice(3);
	if (out.endsWith('```')) out = out.slice(0, -3);
	return out.trim();
}

/**
 * The drift events are rendered with the same field names the Go
 * implementation used, so the prompt Gemini sees is unchanged.
 */
function promptShape(drifts: DriftEvent[]): unknown[] {
	return drifts.map((d) => ({
		ID: d.id,
		Type: d.type,
		ContainerName: d.containerName,
		LiveValue: d.liveValue,
		DeclaredValue: d.declaredValue,
		Severity: d.severity,
		DetectedAt: d.detectedAt.toISOString()
	}));
}

export function buildPrompt(drifts: DriftEvent[]): string {
	const pretty = JSON.stringify(promptShape(drifts ?? []), null, 2);

	return `You are an infrastructure reliability agent analyzing Docker container drift.

The following JSON array contains drift events detected between the live runtime
state of a Docker host and the declared docker-compose.yml configuration in git:

${pretty}

Analyze the drifts and respond with a single JSON object matching exactly this shape:

{
  "severity": "critical | warning | info",
  "summary": "1-2 sentence human-readable summary of what changed",
  "fixCommand": "a single shell command that fixes the most critical drift",
  "explanation": "technical explanation of the most likely root cause",
  "driftBreakdown": [
    {
      "containerName": "name of the container",
      "driftType": "one of env_mismatch | image_stale | port_changed | missing_container | extra_container",
      "fixStep": "specific remediation step for this drift"
    }
  ]
}

Rules:
- Respond with ONLY the JSON object. No markdown fences, no commentary before or after.
- "severity" must be the highest severity across all drifts (critical > warning > info).
- "fixCommand" must be a single executable shell command (e.g. "docker compose up -d --build api").
- "driftBreakdown" must contain exactly one entry per input drift event, matched by container name and drift type.
`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
