import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { Project } from '../../db/models.js';
import {
	createProject,
	deleteProjectForUser,
	getProjectByIdForUser,
	listProjectsForUser,
	setProjectAgentKeyHash,
	setProjectSecrets
} from '../../db/projects.js';
import { getLatestSnapshotByProject } from '../../db/snapshots.js';
import { encrypt } from '../../services/crypto.js';
import { generateAgentKey, hashAgentKey } from '../agentKey.js';
import { currentUserID } from '../auth.js';
import type { ApiDeps } from '../deps.js';
import { isUUID, respond, respondError } from '../respond.js';
import { formatZodError } from '../validate.js';

const createProjectSchema = z.object({
	name: z.string().min(1),
	repo_owner: z.string().min(1),
	repo_name: z.string().min(1),
	repo_branch: z.string().optional(),
	/** Optional. Only needed for PRIVATE repos. Stored encrypted at rest. */
	github_token: z.string().optional(),
	/** Optional. Per-project Discord webhook for drift alerts. Blank = no alerts. */
	discord_webhook_url: z.string().optional()
});

/**
 * The safe public shape of a project: it never exposes the stored secrets,
 * only whether they are set.
 */
export interface ProjectResponse {
	id: string;
	name: string;
	repo_owner: string;
	repo_name: string;
	repo_branch: string;
	has_github_token: boolean;
	has_discord_webhook: boolean;
	created_at: Date;
	updated_at: Date;
	user_id: string | null;
}

export function toProjectResponse(p: Project): ProjectResponse {
	return {
		id: p.id,
		name: p.name,
		repo_owner: p.repo_owner,
		repo_name: p.repo_name,
		repo_branch: p.repo_branch,
		has_github_token: !!p.github_token_encrypted,
		has_discord_webhook: p.discord_webhook_url !== '',
		created_at: p.created_at,
		updated_at: p.updated_at,
		user_id: p.user_id
	};
}

export function projectRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.post('/projects', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;

		const parsed = createProjectSchema.safeParse(req.body);
		if (!parsed.success) {
			respondError(res, 400, formatZodError(parsed.error), 'VALIDATION_ERROR');
			return;
		}
		const input = parsed.data;
		const repoBranch = input.repo_branch || 'main';

		// Encrypt the user's GitHub token (if any) before it ever touches the DB.
		let encToken: string | null = null;
		if (input.github_token) {
			try {
				encToken = encrypt(input.github_token);
			} catch {
				respondError(res, 500, 'could not secure github token', 'ENCRYPT_ERROR');
				return;
			}
		}

		let project: Project;
		try {
			project = await createProject(deps.db, {
				name: input.name,
				repo_owner: input.repo_owner,
				repo_name: input.repo_name,
				repo_branch: repoBranch,
				docker_host: '', // unused in agent-push model; column kept for compatibility
				github_token_encrypted: encToken,
				user_id: userID
			});
		} catch {
			respondError(res, 500, 'could not create project', 'CREATE_ERROR');
			return;
		}

		// Persist the optional per-project Discord webhook alongside the
		// (already stored) encrypted token.
		if (input.discord_webhook_url) {
			try {
				await setProjectSecrets(
					deps.db,
					project.id,
					encToken,
					input.discord_webhook_url
				);
				project.discord_webhook_url = input.discord_webhook_url;
			} catch {
				respondError(
					res,
					500,
					'could not store project secrets',
					'SECRET_STORE_ERROR'
				);
				return;
			}
		}

		// Issue a one-time agent key. Only its SHA-256 hash is stored; the
		// plaintext is returned here once and never shown again. The user gives
		// it to the agent.
		const agentKey = generateAgentKey();
		try {
			await setProjectAgentKeyHash(deps.db, project.id, hashAgentKey(agentKey));
		} catch {
			respondError(res, 500, 'could not store agent key', 'KEY_STORE_ERROR');
			return;
		}

		deps.scheduler.registerProject(project);

		// Keep the standard {data, message} envelope. `data` is the sanitized
		// project (no secrets); the one-time agent_key is a sibling field.
		res.status(201).json({
			data: toProjectResponse(project),
			agent_key: agentKey,
			message: 'project created — save the agent_key now, it is shown only once'
		});
	});

	r.get('/projects', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;

		try {
			const projects = await listProjectsForUser(deps.db, userID);
			respond(res, 200, projects.map(toProjectResponse));
		} catch {
			respondError(res, 500, 'could not list projects', 'LIST_ERROR');
		}
	});

	r.get('/projects/:id', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;
		if (!isUUID(req.params.id)) {
			respondError(res, 400, 'invalid project id', 'INVALID_ID');
			return;
		}

		const project = await getProjectByIdForUser(deps.db, req.params.id, userID);
		if (!project) {
			respondError(res, 404, 'project not found', 'NOT_FOUND');
			return;
		}

		const snapshot = await getLatestSnapshotByProject(deps.db, project.id).catch(
			() => null
		);

		respond(res, 200, {
			project: toProjectResponse(project),
			latest_snapshot: snapshot
		});
	});

	r.delete('/projects/:id', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;
		if (!isUUID(req.params.id)) {
			respondError(res, 400, 'invalid project id', 'INVALID_ID');
			return;
		}

		let rows: number;
		try {
			rows = await deleteProjectForUser(deps.db, req.params.id, userID);
		} catch {
			respondError(res, 500, 'could not delete project', 'DELETE_ERROR');
			return;
		}
		if (rows === 0) {
			respondError(res, 404, 'project not found', 'NOT_FOUND');
			return;
		}

		deps.scheduler.unregisterProject(req.params.id);

		respond(res, 200, null, 'project deleted');
	});

	return r;
}

/**
 * requireProjectOwnership verifies that the authenticated user owns the project
 * identified by the :id URL param. Resolves to the project, or writes the
 * appropriate error response and resolves to null.
 */
export async function requireProjectOwnership(
	deps: ApiDeps,
	req: Request,
	res: Response
): Promise<Project | null> {
	const userID = currentUserID(req, res);
	if (!userID) return null;

	const id = typeof req.params.id === 'string' ? req.params.id : '';
	if (!isUUID(id)) {
		respondError(res, 400, 'invalid project id', 'INVALID_ID');
		return null;
	}

	const project = await getProjectByIdForUser(deps.db, id, userID);
	if (!project) {
		respondError(res, 404, 'project not found', 'NOT_FOUND');
		return null;
	}
	return project;
}
