import jwt from 'jsonwebtoken';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { respondError } from './respond.js';

const ISSUER = 'driftwatch';
const TTL_SECONDS = 24 * 60 * 60;

export interface Claims {
	/** The authenticated user's UUID. */
	uid: string;
	iss?: string;
	iat?: number;
	nbf?: number;
	exp?: number;
}

export interface IssuedToken {
	token: string;
	expiresAt: Date;
}

/** Mints a 24h DriftWatch session token for a user id. */
export function issueJWT(userId: string, secret: string): IssuedToken {
	const now = Math.floor(Date.now() / 1000);
	const exp = now + TTL_SECONDS;
	const token = jwt.sign(
		{ uid: userId, iss: ISSUER, iat: now, nbf: now, exp },
		secret,
		{ algorithm: 'HS256' }
	);
	return { token, expiresAt: new Date(exp * 1000) };
}

/**
 * requireAuth verifies the bearer token and stashes the user id on the request.
 * The algorithm allowlist is what stops an attacker swapping HS256 for "none".
 */
export function requireAuth(secret: string): RequestHandler {
	return (req: Request, res: Response, next: NextFunction): void => {
		const header = req.get('Authorization');
		if (!header?.startsWith('Bearer ')) {
			respondError(
				res,
				401,
				'missing or invalid Authorization header',
				'AUTH_MISSING'
			);
			return;
		}

		try {
			const claims = jwt.verify(header.slice('Bearer '.length), secret, {
				algorithms: ['HS256']
			}) as Claims;
			if (!claims.uid) {
				respondError(res, 401, 'invalid or expired token', 'AUTH_INVALID');
				return;
			}
			req.userId = claims.uid;
			next();
		} catch {
			respondError(res, 401, 'invalid or expired token', 'AUTH_INVALID');
		}
	};
}

/**
 * currentUserID pulls the authenticated user's UUID off the request. Returns
 * null and writes a 401 when the middleware didn't run.
 */
export function currentUserID(req: Request, res: Response): string | null {
	if (!req.userId) {
		respondError(res, 401, 'auth required', 'AUTH_MISSING');
		return null;
	}
	return req.userId;
}
