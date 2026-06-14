/**
 * Standalone migration runner: `npm run migrate`.
 *
 * The server applies migrations at boot too, so this is only needed to migrate
 * a database out-of-band (e.g. before a deploy, or against a scratch DB).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

const config = loadConfig();

runMigrations(config.databaseUrl, MIGRATIONS_DIR)
	.then(() => {
		logger.info('migrations applied');
		process.exit(0);
	})
	.catch((err: Error) => {
		logger.error('migrations failed', { error: err });
		process.exit(1);
	});
