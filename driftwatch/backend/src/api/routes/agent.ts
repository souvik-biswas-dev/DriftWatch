import { Router } from 'express';
import { z } from 'zod';

import { getProjectByAgentKeyHash } from '../../db/projects.js';
import { logger } from '../../logger.js';
import type { LiveSnapshot } from '../../types.js';
import { AGENT_KEY_HEADER, hashAgentKey } from '../agentKey.js';
import type { ApiDeps } from '../deps.js';
import { respond, respondError } from '../respond.js';
import { formatZodError } from '../validate.js';

/**
 * Deliberately permissive: an older agent that omits a field should still be
 * accepted rather than 400'd out of monitoring.
 */
const containerStateSchema = z.object({
	name: z.string().default(''),
	image: z.string().default(''),
	env: z.record(z.string(), z.string()).default({}),
	ports: z.array(z.string()).default([]),
	running: z.boolean().default(false)
});

const liveSnapshotSchema = z.object({
	containers: z.array(containerStateSchema).default([]),
	captured_at: z.string().default(() => new Date().toISOString())
});

/**
 * Ingests a live Docker snapshot pushed by a project's agent. The agent runs on
 * the user's own host, so the backend never reaches into their Docker daemon.
 */
export function agentRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.post('/agent/state', async (req, res) => {
		const key = req.get(AGENT_KEY_HEADER);
		if (!key) {
			respondError(res, 401, 'missing agent key', 'NO_AGENT_KEY');
			return;
		}

		let project;
		try {
			project = await getProjectByAgentKeyHash(deps.db, hashAgentKey(key));
		} catch {
			respondError(res, 500, 'lookup failed', 'DB_ERROR');
			return;
		}
		if (!project) {
			respondError(res, 401, 'invalid agent key', 'BAD_AGENT_KEY');
			return;
		}

		const parsed = liveSnapshotSchema.safeParse(req.body);
		if (!parsed.success) {
			respondError(res, 400, formatZodError(parsed.error), 'INVALID_BODY');
			return;
		}
		const live: LiveSnapshot = parsed.data;

		// Run the scan in the background so the agent gets a fast acknowledgement.
		void deps.scheduler.ingestLiveState(project.id, live).catch((err) => {
			logger.error('agent ingest failed', { project_id: project.id, error: err });
		});

		respond(res, 202, { project_id: project.id }, 'state accepted');
	});

	return r;
}
