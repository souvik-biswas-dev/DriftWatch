import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { listProjectsByRepo } from '../../db/projects.js';
import { logger } from '../../logger.js';
import type { ApiDeps } from '../deps.js';
import { respond, respondError } from '../respond.js';
import { formatZodError } from '../validate.js';

/**
 * The envelope the Cloudflare worker forwards after verifying GitHub's HMAC.
 * The worker strips GitHub's verbose payload down to just the fields we need.
 */
const webhookSchema = z.object({
	repo_full_name: z.string().min(1),
	ref: z.string().optional().default(''),
	head_commit_sha: z.string().optional().default('')
});

/** Constant-time comparison that tolerates differing lengths. */
function secretsMatch(got: string, want: string): boolean {
	const a = Buffer.from(got);
	const b = Buffer.from(want);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Called by the Cloudflare worker after it has verified GitHub's signature. We
 * trust the worker via X-DriftWatch-Secret and fan out a scan to every project
 * tracking the pushed repo — multiple users can monitor the same repo on
 * different Docker hosts.
 */
export function webhookRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.post('/webhook/github', async (req, res) => {
		if (deps.webhookSecret === '') {
			respondError(res, 503, 'webhook not configured', 'WEBHOOK_DISABLED');
			return;
		}
		if (!secretsMatch(req.get('X-DriftWatch-Secret') ?? '', deps.webhookSecret)) {
			respondError(res, 401, 'invalid webhook secret', 'WEBHOOK_AUTH');
			return;
		}

		const parsed = webhookSchema.safeParse(req.body);
		if (!parsed.success) {
			respondError(res, 400, formatZodError(parsed.error), 'VALIDATION_ERROR');
			return;
		}

		const [owner, name] = splitRepoFullName(parsed.data.repo_full_name);
		if (!owner || !name) {
			respondError(res, 400, "repo_full_name must be 'owner/name'", 'INVALID_REPO');
			return;
		}

		let projects;
		try {
			projects = await listProjectsByRepo(deps.db, owner, name);
		} catch {
			respondError(res, 500, 'lookup failed', 'LOOKUP_ERROR');
			return;
		}

		if (projects.length === 0) {
			// No project tracks this repo — acknowledge but no-op so GitHub
			// doesn't retry. The worker has already verified the signature.
			respond(res, 202, { matched: 0, triggered: 0 }, 'no projects match repo');
			return;
		}

		let triggered = 0;
		for (const p of projects) {
			try {
				await deps.scheduler.triggerScan(p.id);
				triggered++;
			} catch (err) {
				logger.error('webhook: trigger scan', { project_id: p.id, error: err });
			}
		}

		respond(
			res,
			202,
			{ matched: projects.length, triggered, ref: parsed.data.ref },
			'scans triggered'
		);
	});

	return r;
}

function splitRepoFullName(full: string): [string, string] {
	const idx = full.indexOf('/');
	if (idx === -1) return ['', ''];
	return [full.slice(0, idx), full.slice(idx + 1)];
}
