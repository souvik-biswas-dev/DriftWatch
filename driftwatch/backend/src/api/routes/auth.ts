import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';

import { createUser, getUserByEmail } from '../../db/users.js';
import { issueJWT } from '../auth.js';
import type { ApiDeps } from '../deps.js';
import { respond, respondError } from '../respond.js';
import { formatZodError } from '../validate.js';

const registerSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8)
});

const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1)
});

const BCRYPT_COST = 10; // matches Go's bcrypt.DefaultCost

/**
 * Legacy email/password auth. Kept for backward compatibility; the dashboard
 * signs in with GitHub OAuth (see oauth.ts).
 */
export function authRoutes(deps: ApiDeps): Router {
	const r = Router();

	r.post('/auth/register', async (req, res) => {
		const parsed = registerSchema.safeParse(req.body);
		if (!parsed.success) {
			respondError(res, 400, formatZodError(parsed.error), 'VALIDATION_ERROR');
			return;
		}

		const hash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

		try {
			const user = await createUser(deps.db, parsed.data.email, hash);
			respond(res, 201, { id: user.id, email: user.email }, 'user created');
		} catch {
			// Most likely a unique-violation on email.
			respondError(res, 409, 'email already registered', 'EMAIL_TAKEN');
		}
	});

	r.post('/auth/login', async (req, res) => {
		const parsed = loginSchema.safeParse(req.body);
		if (!parsed.success) {
			respondError(res, 400, formatZodError(parsed.error), 'VALIDATION_ERROR');
			return;
		}

		const user = await getUserByEmail(deps.db, parsed.data.email);
		// Generic message — don't leak whether the email exists.
		// GitHub-OAuth users have no password set; reject password login for them.
		if (!user || !user.password_hash) {
			respondError(res, 401, 'invalid credentials', 'INVALID_CREDENTIALS');
			return;
		}
		if (!(await bcrypt.compare(parsed.data.password, user.password_hash))) {
			respondError(res, 401, 'invalid credentials', 'INVALID_CREDENTIALS');
			return;
		}

		const { token, expiresAt } = issueJWT(user.id, deps.jwtSecret);
		respond(res, 200, { token, expires_at: expiresAt }, 'login successful');
	});

	return r;
}
