import { Router } from 'express';

import { getUserProfile } from '../db/users.js';
import { currentUserID, requireAuth } from './auth.js';
import type { ApiDeps } from './deps.js';
import { respond, respondError } from './respond.js';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { driftRoutes } from './routes/drifts.js';
import { githubRoutes } from './routes/github.js';
import { oauthRoutes } from './routes/oauth.js';
import { projectRoutes } from './routes/projects.js';
import { webhookRoutes } from './routes/webhook.js';

/**
 * Builds the router mounted at /api. Everything registered before
 * requireAuth() is public; everything after it needs a bearer token.
 */
export function apiRouter(deps: ApiDeps): Router {
	const r = Router();

	// Legacy email/password (kept for backward compatibility; the dashboard now
	// uses GitHub OAuth exclusively).
	r.use(authRoutes(deps));

	// GitHub OAuth: browser hits /login → redirected to GitHub → /callback
	// issues a JWT and redirects back to the dashboard.
	r.use(oauthRoutes(deps));

	// Internal webhook — verified by shared-secret header, not JWT.
	r.use(webhookRoutes(deps));

	// Agent ingest — authenticated by the per-project agent key header, not JWT.
	r.use(agentRoutes(deps));

	// ── Everything below requires a valid session token ──────────────────────
	r.use(requireAuth(deps.jwtSecret));

	/** The authenticated user's public profile (dashboard header avatar/login). */
	r.get('/me', async (req, res) => {
		const userID = currentUserID(req, res);
		if (!userID) return;

		const user = await getUserProfile(deps.db, userID);
		if (!user) {
			respondError(res, 404, 'user not found', 'NOT_FOUND');
			return;
		}
		respond(res, 200, {
			id: user.id,
			email: user.email,
			github_login: user.github_login,
			avatar_url: user.avatar_url
		});
	});

	r.use(projectRoutes(deps));
	r.use(driftRoutes(deps));

	// GitHub repo/branch picker — returns data from the user's own OAuth token.
	r.use(githubRoutes(deps));

	return r;
}
