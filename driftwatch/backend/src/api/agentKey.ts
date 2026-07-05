import { createHash, randomBytes } from 'node:crypto';

/**
 * Header carrying the plaintext agent key when an agent pushes live Docker
 * state. The backend only ever stores its SHA-256 hash.
 */
export const AGENT_KEY_HEADER = 'X-DriftWatch-Agent-Key';

/** Returns the lowercase hex SHA-256 of an agent key. */
export function hashAgentKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/** Returns a new random agent key (prefixed "dw_"). */
export function generateAgentKey(): string {
	return 'dw_' + randomBytes(24).toString('hex');
}
