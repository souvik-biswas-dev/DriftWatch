/**
 * Process configuration. Loaded once, at import time, so every other module
 * reads the same frozen snapshot instead of poking at process.env directly.
 */
import dotenv from 'dotenv';

import { logger } from './logger.js';

const loaded = dotenv.config();
if (loaded.error) {
	logger.info('no .env file found; using process environment');
}

function getenv(key: string, fallback: string): string {
	const v = process.env[key];
	return v !== undefined && v !== '' ? v : fallback;
}

function mustEnv(key: string): string {
	const v = process.env[key];
	if (!v) {
		logger.error('required environment variable missing', { key });
		process.exit(1);
	}
	return v;
}

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
	/**
	 * Where the callback sends the browser with the issued JWT,
	 * e.g. https://driftwatch.pages.dev. The token is appended as #token=...
	 */
	dashboardUrl: string;
	/**
	 * This service's external base URL, used to build the OAuth redirect_uri
	 * (e.g. https://driftwatch-3drv.onrender.com). Empty → reconstructed from
	 * the incoming request.
	 */
	backendUrl: string;
}

/** True when GitHub OAuth sign-in is configured. */
export function oauthEnabled(o: OAuthConfig): boolean {
	return o.clientId !== '' && o.clientSecret !== '';
}

export interface Config {
	port: number;
	databaseUrl: string;
	redisUrl: string;
	jwtSecret: string;
	geminiApiKey: string;
	geminiModel: string;
	githubToken: string;
	discordWebhookUrl: string;
	webhookSecret: string;
	allowedOrigin: string;
	encryptionKey: string;
	backendUrl: string;
	oauth: OAuthConfig;
}

/**
 * loadConfig reads and validates the environment. It is called from the server
 * entrypoint, not at import time, so tests and the agent CLI can import modules
 * from this package without a database URL being present.
 */
export function loadConfig(): Config {
	return {
		port: Number(getenv('PORT', '8080')),
		databaseUrl: mustEnv('DATABASE_URL'),
		redisUrl: mustEnv('REDIS_URL'),
		jwtSecret: mustEnv('JWT_SECRET'),

		geminiApiKey: getenv('GEMINI_API_KEY', ''),
		geminiModel: getenv('GEMINI_MODEL', ''),
		githubToken: getenv('GITHUB_TOKEN', ''),
		discordWebhookUrl: getenv('DISCORD_WEBHOOK_URL', ''),
		webhookSecret: getenv('WEBHOOK_SECRET', ''),
		allowedOrigin: getenv('ALLOWED_ORIGIN', 'http://localhost:5173'),
		encryptionKey: getenv('ENCRYPTION_KEY', ''),
		backendUrl: getenv('BACKEND_URL', ''),

		oauth: {
			clientId: getenv('GITHUB_OAUTH_CLIENT_ID', ''),
			clientSecret: getenv('GITHUB_OAUTH_CLIENT_SECRET', ''),
			dashboardUrl: getenv('DASHBOARD_URL', 'http://localhost:5173'),
			backendUrl: getenv('BACKEND_URL', '')
		}
	};
}
