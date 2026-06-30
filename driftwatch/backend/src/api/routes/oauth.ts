import { randomBytes } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';

import { upsertGithubUser } from '../../db/users.js';
import { oauthEnabled } from '../../env.js';
import { encrypt } from '../../services/crypto.js';
import { issueJWT } from '../auth.js';
import type { ApiDeps } from '../deps.js';
import { respondError } from '../respond.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

const STATE_COOKIE = 'dw_oauth_state';
const STATE_TTL_SECONDS = 600;
const EXCHANGE_TIMEOUT_MS = 15_000;

const COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const;

/**
 * GitHub OAuth sign-in: the browser hits /login, is bounced to GitHub, and the
 * /callback issues a DriftWatch JWT and redirects back to the dashboard.
 */
export function oauthRoutes(deps: ApiDeps): Router {
	const r = Router();

	/**
	 * Redirects to GitHub's consent screen. We request `repo` and `read:user`
	 * so the same token can later read the user's private compose files.
	 */
	r.get('/auth/github/login', (req, res) => {
		if (!oauthEnabled(deps.oauth)) {
			respondError(res, 503, 'GitHub login is not configured', 'OAUTH_DISABLED');
			return;
		}

		// CSRF state: a random token round-tripped via a short-lived cookie.
		const state = randomBytes(16).toString('hex');
		res.cookie(STATE_COOKIE, state, {
			...COOKIE_OPTS,
			maxAge: STATE_TTL_SECONDS * 1000
		});

		const q = new URLSearchParams({
			client_id: deps.oauth.clientId,
			redirect_uri: backendBaseURL(deps, req) + '/api/auth/github/callback',
			scope: 'read:user user:email repo',
			state,
			allow_signup: 'true'
		});

		res.redirect(302, `${GITHUB_AUTHORIZE_URL}?${q.toString()}`);
	});

	/**
	 * Completes the OAuth dance: verify state, exchange the code for an access
	 * token, fetch the GitHub profile, upsert the user, issue our own JWT, and
	 * redirect to the dashboard with the token in the URL fragment.
	 */
	r.get('/auth/github/callback', async (req, res) => {
		if (!oauthEnabled(deps.oauth)) {
			respondError(res, 503, 'GitHub login is not configured', 'OAUTH_DISABLED');
			return;
		}

		const wantState = req.cookies?.[STATE_COOKIE] as string | undefined;
		const gotState = typeof req.query.state === 'string' ? req.query.state : '';
		if (!wantState || !gotState || wantState !== gotState) {
			redirectToDashboardError(deps, res, 'state_mismatch');
			return;
		}
		res.clearCookie(STATE_COOKIE, COOKIE_OPTS);

		const code = typeof req.query.code === 'string' ? req.query.code : '';
		if (!code) {
			redirectToDashboardError(deps, res, 'missing_code');
			return;
		}

		let accessToken: string;
		try {
			accessToken = await exchangeGithubCode(
				deps,
				code,
				backendBaseURL(deps, req) + '/api/auth/github/callback'
			);
		} catch {
			redirectToDashboardError(deps, res, 'token_exchange_failed');
			return;
		}

		let profile: GithubProfile;
		try {
			profile = await fetchGithubProfile(accessToken);
		} catch {
			redirectToDashboardError(deps, res, 'profile_fetch_failed');
			return;
		}

		// Encrypt the OAuth token before storing — it's reused for private repos.
		let encToken: string;
		try {
			encToken = encrypt(accessToken);
		} catch {
			redirectToDashboardError(deps, res, 'encrypt_failed');
			return;
		}

		let user;
		try {
			user = await upsertGithubUser(deps.db, {
				email: profile.email,
				githubId: profile.id,
				githubLogin: profile.login,
				avatarUrl: profile.avatar_url,
				githubTokenEncrypted: encToken
			});
		} catch {
			redirectToDashboardError(deps, res, 'user_upsert_failed');
			return;
		}

		let token: string;
		try {
			token = issueJWT(user.id, deps.jwtSecret).token;
		} catch {
			redirectToDashboardError(deps, res, 'token_sign_failed');
			return;
		}

		// Hand the JWT to the SPA via the URL fragment (never sent to a server,
		// not logged). The dashboard's /auth/callback page reads and stores it.
		const dest =
			trimTrailingSlash(deps.oauth.dashboardUrl) +
			'/auth/callback#token=' +
			encodeURIComponent(token);
		res.redirect(302, dest);
	});

	return r;
}

async function exchangeGithubCode(
	deps: ApiDeps,
	code: string,
	redirectURI: string
): Promise<string> {
	const form = new URLSearchParams({
		client_id: deps.oauth.clientId,
		client_secret: deps.oauth.clientSecret,
		code,
		redirect_uri: redirectURI
	});

	const res = await fetch(GITHUB_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body: form.toString(),
		signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
	});

	const out = (await res.json()) as { access_token?: string; error?: string };
	if (!out.access_token) {
		throw new Error(`github: no access token (${out.error ?? ''})`);
	}
	return out.access_token;
}

interface GithubProfile {
	id: number;
	login: string;
	avatar_url: string;
	email: string;
}

async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
	const raw = await githubGet<Partial<GithubProfile>>(GITHUB_USER_URL, accessToken);
	const profile: GithubProfile = {
		id: raw.id ?? 0,
		login: raw.login ?? '',
		avatar_url: raw.avatar_url ?? '',
		email: raw.email ?? ''
	};

	// The /user email is null when the user keeps it private; fall back to the
	// primary verified address from /user/emails.
	if (profile.email === '') {
		try {
			const emails = await githubGet<
				{ email: string; primary: boolean; verified: boolean }[]
			>(GITHUB_EMAILS_URL, accessToken);
			const primary = emails.find((e) => e.primary && e.verified);
			if (primary) profile.email = primary.email;
		} catch {
			// Leave the email empty; the schema allows it.
		}
	}

	return profile;
}

async function githubGet<T>(url: string, accessToken: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'User-Agent': 'DriftWatch'
		},
		signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
	});
	if (!res.ok) {
		throw new Error(`github GET ${url}: status ${res.status}`);
	}
	return (await res.json()) as T;
}

/**
 * Sends the browser back to the dashboard login with an error code in the query
 * string, so the SPA can show a toast.
 */
function redirectToDashboardError(deps: ApiDeps, res: Response, code: string): void {
	const dest =
		trimTrailingSlash(deps.oauth.dashboardUrl) +
		'/login?error=' +
		encodeURIComponent(code);
	res.redirect(302, dest);
}

/**
 * Reconstructs this backend's external base URL from the request (honoring
 * proxies via X-Forwarded-Proto), used to build the OAuth redirect_uri.
 */
export function backendBaseURL(deps: ApiDeps, req: Request): string {
	if (deps.oauth.backendUrl !== '') return trimTrailingSlash(deps.oauth.backendUrl);

	const forwarded = req.get('X-Forwarded-Proto');
	const scheme = forwarded
		? forwarded
		: (req.socket as { encrypted?: boolean }).encrypted
			? 'https'
			: 'http';
	return `${scheme}://${req.get('host') ?? ''}`;
}

function trimTrailingSlash(s: string): string {
	return s.replace(/\/+$/, '');
}
