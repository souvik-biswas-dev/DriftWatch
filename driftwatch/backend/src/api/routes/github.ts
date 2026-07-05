import { Router } from 'express';

import { getUserGithubToken } from '../../db/users.js';
import { decrypt } from '../../services/crypto.js';
import { currentUserID } from '../auth.js';
import type { ApiDeps } from '../deps.js';
import { respond, respondError } from '../respond.js';

/**
 * Repo/branch pickers for the "new project" flow, read with the user's own
 * OAuth token so private repos show up.
 */
export function githubRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.get('/github/repos', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;

		const token = await resolveUserToken(deps, userID, res);
		if (token === null) return;

		try {
			respond(res, 200, await deps.github.listUserRepos(token));
		} catch {
			respondError(res, 502, 'could not list GitHub repos', 'GITHUB_ERROR');
		}
	});

	r.get('/github/repos/:owner/:repo/branches', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;

		const token = await resolveUserToken(deps, userID, res);
		if (token === null) return;

		try {
			const branches = await deps.github.listRepoBranches(
				req.params.owner,
				req.params.repo,
				token
			);
			respond(res, 200, branches);
		} catch {
			respondError(res, 502, 'could not list branches', 'GITHUB_ERROR');
		}
	});

	return r;
}

/**
 * Loads and decrypts the user's stored OAuth token. Writes the error response
 * and returns null when it isn't usable.
 */
async function resolveUserToken(
	deps: ApiDeps,
	userID: string,
	res: Parameters<typeof respondError>[0]
): Promise<string | null> {
	let enc = '';
	try {
		enc = await getUserGithubToken(deps.db, userID);
	} catch {
		enc = '';
	}
	if (!enc) {
		respondError(
			res,
			400,
			'no GitHub token — log in with GitHub first',
			'NO_GITHUB_TOKEN'
		);
		return null;
	}

	try {
		return decrypt(enc);
	} catch {
		respondError(res, 500, 'could not read GitHub token', 'DECRYPT_ERROR');
		return null;
	}
}
