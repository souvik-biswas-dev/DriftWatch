import { Severity } from '../types.js';
import type { DriftEvent } from '../types.js';
import type { AnalysisResult } from './gemini.js';

const COOLDOWN_MS = 30 * 60 * 1000;

export interface DiscordField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface DiscordEmbed {
	title: string;
	color: number;
	fields: DiscordField[];
	footer: { text: string };
	timestamp: string;
}

export interface DiscordPayload {
	embeds: DiscordEmbed[];
}

export function colorForSeverity(sev: string): number {
	switch (sev) {
		case Severity.Critical:
			return 15158332; // red
		case Severity.Warning:
			return 16776960; // yellow
		case Severity.Info:
			return 3447003; // blue
		default:
			return 3447003;
	}
}

function uniqueContainerCount(drifts: DriftEvent[]): number {
	return new Set((drifts ?? []).map((d) => d.containerName)).size;
}

export class DiscordClient {
	private readonly webhookUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(
		webhookUrl: string,
		opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
	) {
		this.webhookUrl = webhookUrl;
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	/**
	 * Posts to the client's configured webhook URL. Kept for backward
	 * compatibility; multi-user callers use sendDriftAlertTo with the project's
	 * own webhook.
	 */
	async sendDriftAlert(
		projectName: string,
		result: AnalysisResult | null,
		drifts: DriftEvent[]
	): Promise<void> {
		return this.sendDriftAlertTo(this.webhookUrl, projectName, result, drifts);
	}

	/**
	 * Posts a drift alert to a specific Discord webhook URL. An empty URL is a
	 * no-op — alerts are opt-in per project, so a user who doesn't configure
	 * Discord simply gets no alert, and no error is logged.
	 */
	async sendDriftAlertTo(
		webhookUrl: string,
		projectName: string,
		result: AnalysisResult | null,
		drifts: DriftEvent[]
	): Promise<void> {
		if (webhookUrl === '') return;
		if (result === null || result === undefined) {
			throw new Error('alerts: AnalysisResult is nil');
		}

		// RFC3339 with second precision, matching the original payload.
		const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

		const embed: DiscordEmbed = {
			title: `⚠️ Drift Detected — ${projectName}`,
			color: colorForSeverity(result.severity),
			fields: [
				{ name: 'Severity', value: result.severity, inline: true },
				{
					name: 'Containers Affected',
					value: String(uniqueContainerCount(drifts)),
					inline: true
				},
				{ name: 'Summary', value: result.summary },
				{ name: 'Fix Command', value: '```bash\n' + result.fixCommand + '\n```' },
				{ name: 'Explanation', value: result.explanation }
			],
			footer: { text: `DriftWatch • detected at ${timestamp}` },
			timestamp
		};

		const payload: DiscordPayload = { embeds: [embed] };

		const res = await this.fetchImpl(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(this.timeoutMs)
		});

		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`discord webhook returned ${res.status}: ${body}`);
		}
	}

	/**
	 * Returns true if it's been at least 30 minutes since the last alert for
	 * this project (or there's no prior alert recorded).
	 *
	 * projectId is accepted for forward compatibility with per-project state,
	 * but the current implementation is stateless and relies on the caller to
	 * pass the last-alerted timestamp from the DB.
	 */
	shouldAlert(_projectId: string, lastAlertedAt: Date | null): boolean {
		if (lastAlertedAt === null || lastAlertedAt === undefined) return true;
		return Date.now() - lastAlertedAt.getTime() >= COOLDOWN_MS;
	}
}
