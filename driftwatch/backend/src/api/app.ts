import cookieParser from 'cookie-parser';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import { logger } from '../logger.js';
import { corsMiddleware } from './cors.js';
import type { ApiDeps } from './deps.js';
import { apiRouter } from './router.js';

export interface AppOptions {
	allowedOrigin: string;
	/** Readiness probes for /status; reject to mark the dependency down. */
	checkPostgres(): Promise<unknown>;
	checkRedis(): Promise<unknown>;
}

/**
 * Assembles the Express app: middleware, the operational routes, and the /api
 * router. Kept free of process/infrastructure concerns so it can be exercised
 * end-to-end in tests with fake dependencies.
 */
export function createApp(deps: ApiDeps, opts: AppOptions): Express {
	const app = express();
	app.disable('x-powered-by');
	app.set('trust proxy', true);
	app.use(corsMiddleware(opts.allowedOrigin));
	app.use(cookieParser());
	// Agent snapshots grow with the container count; the default 100kb is tight.
	app.use(express.json({ limit: '5mb' }));

	// Root route — a lightweight 200 so uptime monitors and a human hitting the
	// base URL get a friendly response instead of a 404. Express answers HEAD
	// from the GET handler automatically, which UptimeRobot's free tier needs.
	app.get('/', (_req, res) => {
		res.json({
			service: 'driftwatch-backend',
			status: 'ok',
			docs: 'https://github.com/souvik-biswas-dev/driftwatch'
		});
	});

	// Liveness — the process is up. Cheap; safe to hit frequently.
	app.get('/health', (_req, res) => {
		res.json({ status: 'ok' });
	});

	// Readiness — also verifies Postgres + Redis are reachable. Returns 503 if a
	// dependency is down so a monitor can distinguish "process up" from "fully
	// healthy". Each check has a short timeout to stay snappy.
	app.get('/status', async (_req, res) => {
		const out: Record<string, string> = { status: 'ok', postgres: 'ok', redis: 'ok' };
		let code = 200;

		const [pgOk, redisOk] = await Promise.all([
			opts.checkPostgres().then(
				() => true,
				() => false
			),
			opts.checkRedis().then(
				() => true,
				() => false
			)
		]);
		if (!pgOk) {
			out.postgres = 'down';
			out.status = 'degraded';
			code = 503;
		}
		if (!redisOk) {
			out.redis = 'down';
			out.status = 'degraded';
			code = 503;
		}

		res.status(code).json(out);
	});

	app.use('/api', apiRouter(deps));

	// Anything a handler throws (or rejects with) lands here instead of killing
	// the process.
	app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
		logger.error('unhandled request error', {
			method: req.method,
			path: req.path,
			error: err
		});
		if (res.headersSent) return;
		res.status(500).json({ error: 'internal server error', code: 'INTERNAL' });
	});

	return app;
}
