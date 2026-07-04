import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './api/app.js';
import type { ApiDeps } from './api/deps.js';
import { runMigrations } from './db/migrate.js';
import { createPool, ping, withTimeout } from './db/pool.js';
import { loadConfig, oauthEnabled } from './env.js';
import { logger } from './logger.js';
import { cryptoEnabled, initCrypto } from './services/crypto.js';
import { DiscordClient } from './services/discord.js';
import { GeminiClient } from './services/gemini.js';
import { GitHubClient } from './services/github.js';
import { createRedis } from './services/redis.js';
import { Scheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** migrations/ sits next to src/ in dev and next to dist/ in the image. */
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const SHUTDOWN_TIMEOUT_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
	const config = loadConfig();

	if (!oauthEnabled(config.oauth)) {
		logger.warn(
			'GitHub OAuth not configured — set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to enable sign-in'
		);
	}

	// Encryption key for users' per-project GitHub tokens at rest. Optional for
	// local dev (tokens stored plaintext) but REQUIRED for a real multi-user
	// deploy, so warn loudly when it's missing.
	initCrypto(config.encryptionKey);
	if (!cryptoEnabled()) {
		logger.warn(
			'ENCRYPTION_KEY not set — per-project GitHub tokens will be stored UNENCRYPTED; set it before going multi-user'
		);
	}

	// 1. Migrations — applied before opening the app's pool so we fail fast if
	// the database is unreachable or the schema is incompatible.
	await runMigrations(config.databaseUrl, MIGRATIONS_DIR);
	logger.info('migrations applied');

	// 2. Postgres pool.
	const pool = createPool(config.databaseUrl);
	pool.on('error', (err: Error) => logger.error('postgres pool error', { error: err }));
	await ping(pool);
	logger.info('postgres connected', { max_conns: 10 });

	// 3. Redis (Upstash supports rediss:// URLs out of the box).
	const redis = createRedis(config.redisUrl);
	redis.on('error', (err: Error) => logger.error('redis error', { error: err }));
	await withTimeout(redis.ping(), 5000, 'redis ping timed out');
	logger.info('redis connected');

	// 4. Integration clients. Docker is never contacted from here — each
	// project's agent pushes its own live state.
	const github = new GitHubClient(config.githubToken);
	const gemini = new GeminiClient(config.geminiApiKey, { model: config.geminiModel });
	const discord = new DiscordClient(config.discordWebhookUrl);

	// 5. Scheduler: register existing projects, then start the timers.
	const scheduler = new Scheduler({ db: pool, redis, github, gemini, discord });
	await scheduler.loadAllProjects();
	scheduler.start();

	// 6. HTTP layer.
	const deps: ApiDeps = {
		db: pool,
		scheduler,
		github,
		jwtSecret: config.jwtSecret,
		webhookSecret: config.webhookSecret,
		oauth: config.oauth
	};

	const app = createApp(deps, {
		allowedOrigin: config.allowedOrigin,
		checkPostgres: () => ping(pool, 3000),
		checkRedis: () => withTimeout(redis.ping(), 3000, 'redis ping timed out')
	});

	const server = app.listen(config.port, () => {
		logger.info('HTTP server listening', { port: config.port });
	});
	server.headersTimeout = 10_000;

	// 7. Self-ping to prevent Render free-tier sleep (it spins down after 15
	// minutes of inactivity). Requires BACKEND_URL; silently skipped if unset.
	let keepAlive: NodeJS.Timeout | undefined;
	if (config.backendUrl !== '') {
		const pingURL = config.backendUrl.replace(/\/+$/, '') + '/health';
		keepAlive = setInterval(() => {
			fetch(pingURL, { signal: AbortSignal.timeout(10_000) }).catch((err: Error) =>
				logger.warn('keep-alive ping failed', { error: err })
			);
		}, KEEPALIVE_INTERVAL_MS);
		logger.info('keep-alive self-ping enabled', { url: pingURL, interval: '10m' });
	}

	// 8. Graceful shutdown.
	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info('shutdown signal received', { signal });

		const timer = setTimeout(() => {
			logger.error('graceful shutdown timed out; exiting');
			process.exit(1);
		}, SHUTDOWN_TIMEOUT_MS);

		if (keepAlive) clearInterval(keepAlive);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await scheduler.stop();
		await pool.end().catch(() => undefined);
		redis.disconnect();

		clearTimeout(timer);
		logger.info('server stopped cleanly');
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
	logger.error('server fatal', { error: err });
	process.exit(1);
});
