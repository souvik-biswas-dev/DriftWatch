import { Router } from 'express';

import {
	getDriftEventById,
	listDriftEventsByProject,
	resolveDriftEvent
} from '../../db/driftEvents.js';
import type { ApiDeps } from '../deps.js';
import { isUUID, respond, respondError } from '../respond.js';
import { requireProjectOwnership } from './projects.js';

export function driftRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.get('/projects/:id/drifts', async (req, res) => {
		const project = await requireProjectOwnership(deps, req, res);
		if (!project) return;

		try {
			respond(res, 200, await listDriftEventsByProject(deps.db, project.id));
		} catch {
			respondError(res, 500, 'could not list drift events', 'LIST_ERROR');
		}
	});

	r.get('/projects/:id/drifts/:driftId', async (req, res) => {
		const project = await requireProjectOwnership(deps, req, res);
		if (!project) return;
		if (!isUUID(req.params.driftId)) {
			respondError(res, 400, 'invalid drift id', 'INVALID_ID');
			return;
		}

		const drift = await getDriftEventById(deps.db, req.params.driftId);
		// A cross-project drift id must read as "not found", not as someone
		// else's data.
		if (!drift || drift.project_id !== project.id) {
			respondError(res, 404, 'drift event not found', 'NOT_FOUND');
			return;
		}

		respond(res, 200, drift);
	});

	r.post('/projects/:id/drifts/:driftId/resolve', async (req, res) => {
		const project = await requireProjectOwnership(deps, req, res);
		if (!project) return;
		if (!isUUID(req.params.driftId)) {
			respondError(res, 400, 'invalid drift id', 'INVALID_ID');
			return;
		}

		// Cross-project drift IDs would let one user resolve another's events.
		const drift = await getDriftEventById(deps.db, req.params.driftId);
		if (!drift || drift.project_id !== project.id) {
			respondError(res, 404, 'drift event not found', 'NOT_FOUND');
			return;
		}

		try {
			await resolveDriftEvent(deps.db, req.params.driftId);
		} catch {
			respondError(res, 500, 'could not resolve drift event', 'UPDATE_ERROR');
			return;
		}

		respond(res, 200, null, 'drift event resolved');
	});

	return r;
}
