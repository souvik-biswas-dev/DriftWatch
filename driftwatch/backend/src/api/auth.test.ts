import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { issueJWT } from './auth.js';

const SECRET = 'test-secret';

describe('issueJWT', () => {
	it('mints a 24h HS256 token carrying the user id', () => {
		const { token, expiresAt } = issueJWT('11111111-2222-3333-4444-555555555555', SECRET);

		const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as {
			uid: string;
			iss: string;
			exp: number;
		};

		expect(claims.uid).toBe('11111111-2222-3333-4444-555555555555');
		expect(claims.iss).toBe('driftwatch');
		expect(claims.exp * 1000).toBe(expiresAt.getTime());

		const ttlHours = (expiresAt.getTime() - Date.now()) / 3_600_000;
		expect(ttlHours).toBeGreaterThan(23.9);
		expect(ttlHours).toBeLessThanOrEqual(24);
	});

	it('rejects a token signed with a different secret', () => {
		const { token } = issueJWT('user', SECRET);
		expect(() => jwt.verify(token, 'other-secret')).toThrow();
	});

	it('rejects an unsigned "alg: none" token', () => {
		const forged =
			Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
			'.' +
			Buffer.from(JSON.stringify({ uid: 'attacker' })).toString('base64url') +
			'.';
		expect(() => jwt.verify(forged, SECRET, { algorithms: ['HS256'] })).toThrow();
	});
});
