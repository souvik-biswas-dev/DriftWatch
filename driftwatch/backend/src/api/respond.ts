import type { Response } from 'express';

/** Writes the success envelope: {"data": ..., "message": "..."}. */
export function respond(
	res: Response,
	status: number,
	data: unknown,
	message = ''
): void {
	res.status(status).json({ data, message });
}

/** Writes the error envelope: {"error": "...", "code": "..."}. */
export function respondError(
	res: Response,
	status: number,
	error: string,
	code: string
): void {
	res.status(status).json({ error, code });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(s: string | undefined): s is string {
	return typeof s === 'string' && UUID_RE.test(s);
}
