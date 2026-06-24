import { createHash } from 'node:crypto';

import * as driftEventsDb from '../db/driftEvents.js';
import * as projectsDb from '../db/projects.js';
import * as snapshotsDb from '../db/snapshots.js';
import type { Project } from '../db/models.js';
import type { Queryable } from '../db/pool.js';
import { getUserGithubToken } from '../db/users.js';
import { stableStringify } from '../json.js';
import { logger, type Logger } from '../logger.js';
import type { DriftEvent, LiveSnapshot } from '../types.js';
import { decrypt } from './crypto.js';
import { diff } from './diff.js';
import type { DiscordClient } from './discord.js';
import type { Analyzer } from './gemini.js';
import type { GitHubClient } from './github.js';
import type { RedisClient } from './redis.js';

/** Matches the Go scheduler's `@every 60s` cron entry. */
const SCAN_INTERVAL_MS = 60_000;

/**
 * TTL on the state-hash key. It matches the scan interval so a failed scan
 * (e.g. a GitHub fetch error) is retried on the next agent push instead of
 * being skipped permanently.
 */
const HASH_TTL_SECONDS = 120;

/** Redis key holding the most recent live snapshot an agent pushed. */
function liveKey(projectId: string): string {
	return `driftwatch:live:${projectId}`;
}

function hashKey(projectId: string): string {
	return `driftwatch:hash:v2:${projectId}`;
}

export interface SchedulerDeps {
	db: Queryable;
	redis: RedisClient;
	github: GitHubClient;
	gemini: Analyzer;
	discord: DiscordClient;
}

/** The subset of the scheduler the HTTP layer drives. */
export interface SchedulerAPI {
	registerProject(p: Project): void;
	unregisterProject(projectId: string): void;
	triggerScan(projectId: string): Promise<void>;
	ingestLiveState(projectId: string, live: LiveSnapshot): Promise<void>;
}

export class Scheduler implements SchedulerAPI {
	private readonly deps: SchedulerDeps;
	private readonly projects = new Map<string, Project>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly inFlight = new Set<Promise<void>>();
	private running = false;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	start(): void {
		this.running = true;
		for (const [id, project] of this.projects) {
			if (!this.timers.has(id)) this.arm(project);
		}
		logger.info('scheduler started');
	}

	/** Waits for in-flight scans to finish before returning. */
	async stop(): Promise<void> {
		this.running = false;
		for (const timer of this.timers.values()) clearInterval(timer);
		this.timers.clear();
		await Promise.allSettled([...this.inFlight]);
		logger.info('scheduler stopped');
	}

	registerProject(project: Project): void {
		this.projects.set(project.id, project);
		if (this.running && !this.timers.has(project.id)) this.arm(project);
		logger.info('scheduler: project registered', {
			project_id: project.id,
			name: project.name
		});
	}

	unregisterProject(projectId: string): void {
		const timer = this.timers.get(projectId);
		if (timer) {
			clearInterval(timer);
			this.timers.delete(projectId);
		}
		if (!this.projects.delete(projectId)) return;
		logger.info('scheduler: project unregistered', { project_id: projectId });
	}

	/**
	 * Runs a scan for the given project immediately, out-of-band from the
	 * interval. Called by the webhook handler when a push lands on the tracked
	 * repo. Rejects if the project can't be looked up.
	 */
	async triggerScan(projectId: string): Promise<void> {
		const project = await projectsDb.getProjectById(this.deps.db, projectId);
		if (!project) {
			throw new Error(`scheduler: lookup project: ${projectId} not found`);
		}
		this.track(this.runProjectScan(project));
	}

	/**
	 * Called when a project's agent pushes its live Docker state. Caches the
	 * snapshot (so interval and webhook scans can reuse it) and runs a drift
	 * scan immediately. The backend never connects to the user's Docker host.
	 */
	async ingestLiveState(projectId: string, live: LiveSnapshot): Promise<void> {
		try {
			await this.deps.redis.set(
				liveKey(projectId),
				stableStringify(live),
				'EX',
				24 * 60 * 60
			);
		} catch (err) {
			logger.warn('scheduler: cache live state', { project_id: projectId, error: err });
		}

		const project = await projectsDb.getProjectById(this.deps.db, projectId);
		if (!project) {
			logger.error('scheduler: ingest lookup', {
				project_id: projectId,
				error: 'project not found'
			});
			return;
		}
		await this.runProjectScan(project);
	}

	async loadAllProjects(): Promise<void> {
		let projects: Project[];
		try {
			projects = await projectsDb.listProjects(this.deps.db);
		} catch (err) {
			logger.error('scheduler: load projects', { error: err });
			return;
		}
		for (const p of projects) this.registerProject(p);
		logger.info('scheduler: projects loaded', { count: projects.length });
	}

	private arm(project: Project): void {
		const timer = setInterval(() => {
			// The project row is captured at registration time, matching the
			// original cron closure.
			this.track(this.runProjectScan(project));
		}, SCAN_INTERVAL_MS);
		this.timers.set(project.id, timer);
	}

	/** Keeps a handle on background scans so stop() can drain them. */
	private track(p: Promise<void>): void {
		this.inFlight.add(p);
		void p.finally(() => this.inFlight.delete(p));
	}

	/**
	 * The per-tick body for a project: pull the last live state pushed by its
	 * agent, short-circuit via Redis if unchanged, diff against the declared
	 * state in git, persist, ask the AI for a summary, and alert.
	 */
	private async runProjectScan(project: Project): Promise<void> {
		const log = logger.with({ project_id: project.id, project_name: project.name });
		try {
			await this.scan(project, log);
		} catch (err) {
			log.error('scan failed', { error: err });
		}
	}

	private async scan(project: Project, log: Logger): Promise<void> {
		const { db, redis, github, gemini, discord } = this.deps;

		// Live state is supplied by the project's agent and cached in Redis. The
		// backend never connects to the user's Docker host directly.
		const live = await this.lastLiveState(project.id);
		if (!live) {
			log.info('no agent state cached yet; skipping scan');
			return;
		}

		const liveJSON = stableStringify(live);
		const stateHash = createHash('sha256').update(liveJSON).digest('hex');

		const key = hashKey(project.id);
		let prev: string | null = null;
		try {
			prev = await redis.get(key);
		} catch (err) {
			log.error('redis get', { key, error: err });
		}
		if (prev === stateHash) {
			log.info('no change in live state, skipping scan');
			return;
		}
		try {
			await redis.set(key, stateHash, 'EX', HASH_TTL_SECONDS);
		} catch (err) {
			log.error('redis set', { key, error: err });
		}

		const ghToken = await this.resolveGithubToken(project, log);

		let declared: LiveSnapshot;
		try {
			declared = await github.fetchDeclaredConfigWithToken(
				project.repo_owner,
				project.repo_name,
				project.repo_branch,
				ghToken
			);
		} catch (err) {
			log.error('fetch declared config', { error: err });
			return;
		}

		// Always create a snapshot so "Last check" reflects every scan, not just
		// scans that found drift.
		const snapshot = await snapshotsDb.createSnapshot(db, {
			projectId: project.id,
			stateHash,
			liveState: liveJSON,
			declaredState: stableStringify(declared)
		});

		const drifts = diff(live, declared);
		if (drifts.length === 0) {
			log.info('no drift detected');
			return;
		}
		log.info('drift detected', { count: drifts.length });

		const saved: { id: string; drift: DriftEvent }[] = [];
		for (const d of drifts) {
			// Skip if an identical unresolved drift already exists — prevents
			// duplicate events accumulating on every scan cycle.
			const exists = await driftEventsDb
				.hasOpenDriftEvent(db, project.id, d.containerName, d.type)
				.catch(() => false);
			if (exists) continue;

			try {
				const evt = await driftEventsDb.createDriftEvent(db, {
					projectId: project.id,
					snapshotId: snapshot.id,
					driftType: d.type,
					containerName: d.containerName,
					liveValue: d.liveValue,
					declaredValue: d.declaredValue,
					severity: d.severity,
					aiSummary: null,
					fixCommand: null
				});
				saved.push({ id: evt.id, drift: d });
			} catch (err) {
				log.error('create drift event', { drift_type: d.type, error: err });
			}
		}

		let analysis = null;
		try {
			analysis = await gemini.analyze(drifts);
		} catch (err) {
			log.error('gemini analyze', { error: err });
		}

		if (!analysis) {
			log.warn('skipping discord alert: no AI analysis available');
			return;
		}

		// Backfill the per-row AI summary + fix command, matched by
		// (container, type).
		const breakdown = new Map<string, string>();
		for (const b of analysis.driftBreakdown ?? []) {
			breakdown.set(`${b.containerName}|${b.driftType}`, b.fixStep);
		}
		for (const sd of saved) {
			const cmd =
				breakdown.get(`${sd.drift.containerName}|${sd.drift.type}`) ||
				analysis.fixCommand;
			try {
				await driftEventsDb.updateDriftEventAnalysis(
					db,
					sd.id,
					analysis.summary,
					cmd
				);
			} catch (err) {
				log.error('update drift event analysis', { id: sd.id, error: err });
			}
		}

		// Alert to the project's own Discord webhook. An empty URL is a clean
		// no-op, so users who don't configure Discord simply get no alert.
		try {
			await discord.sendDriftAlertTo(
				project.discord_webhook_url,
				project.name,
				analysis,
				drifts
			);
		} catch (err) {
			log.error('discord alert', { error: err });
			return;
		}

		if (project.discord_webhook_url === '') {
			log.info('scan complete (no discord webhook configured)', {
				drift_count: drifts.length
			});
			return;
		}

		for (const sd of saved) {
			try {
				await driftEventsDb.markDriftEventAlerted(db, sd.id);
			} catch (err) {
				log.error('mark drift event alerted', { id: sd.id, error: err });
			}
		}

		log.info('scan complete', { drift_count: drifts.length, alerted: saved.length });
	}

	/**
	 * Resolves the GitHub token used to read this project's repo, in priority
	 * order:
	 *   1. the project's own token (if the user pasted one), else
	 *   2. the owner's GitHub OAuth token (granted at login with `repo` scope), else
	 *   3. empty → unauthenticated (fine for public repos).
	 */
	private async resolveGithubToken(project: Project, log: Logger): Promise<string> {
		if (project.github_token_encrypted) {
			try {
				return decrypt(project.github_token_encrypted);
			} catch (err) {
				log.error('decrypt project github token', { error: err });
			}
		}

		if (project.user_id) {
			try {
				const enc = await getUserGithubToken(this.deps.db, project.user_id);
				if (enc) return decrypt(enc);
			} catch (err) {
				log.error('decrypt owner oauth token', { error: err });
			}
		}

		return '';
	}

	/** Returns the most recent snapshot an agent pushed for a project. */
	private async lastLiveState(projectId: string): Promise<LiveSnapshot | null> {
		let raw: string | null;
		try {
			raw = await this.deps.redis.get(liveKey(projectId));
		} catch {
			return null;
		}
		if (!raw) return null;
		try {
			return JSON.parse(raw) as LiveSnapshot;
		} catch {
			return null;
		}
	}
}
