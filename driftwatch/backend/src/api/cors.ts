import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * corsMiddleware allows the configured origin(s) plus, for Cloudflare Pages
 * projects, any preview subdomain of them.
 *
 * The configured origins are normalized: spaces and a trailing slash are
 * trimmed, so "https://x.pages.dev/" and "https://x.pages.dev" both match the
 * browser's Origin header (which never has a trailing slash).
 */
export function corsMiddleware(allowedOrigin: string): RequestHandler {
	const allow = allowedOrigin
		.split(',')
		.map((v) => v.trim().replace(/\/+$/, ''));

	return (req: Request, res: Response, next: NextFunction): void => {
		const origin = req.get('Origin');
		if (origin) {
			const reqOrigin = origin.replace(/\/+$/, '');
			for (const a of allow) {
				// Exact match, wildcard, or any Cloudflare Pages preview
				// subdomain of the configured project (*.driftwatch.pages.dev),
				// since each deploy gets a new hashed subdomain.
				if (a === '*' || a === reqOrigin || isPagesPreview(reqOrigin, a)) {
					res.setHeader('Access-Control-Allow-Origin', origin);
					res.setHeader('Vary', 'Origin');
					break;
				}
			}
		}
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, Authorization, X-DriftWatch-Secret, X-DriftWatch-Agent-Key'
		);
		res.setHeader('Access-Control-Max-Age', '300');

		if (req.method === 'OPTIONS') {
			res.status(204).end();
			return;
		}
		next();
	};
}

/**
 * isPagesPreview reports whether reqOrigin is a Cloudflare Pages preview
 * subdomain of the configured production origin. E.g. an allowed
 * "https://driftwatch.pages.dev" also accepts
 * "https://247bc5d9.driftwatch.pages.dev".
 */
export function isPagesPreview(reqOrigin: string, allowed: string): boolean {
	const scheme = 'https://';
	if (!allowed.startsWith(scheme) || !reqOrigin.startsWith(scheme)) return false;
	const host = allowed.slice(scheme.length); // e.g. driftwatch.pages.dev
	if (!host.endsWith('.pages.dev')) return false;
	return reqOrigin.endsWith('.' + host);
}
