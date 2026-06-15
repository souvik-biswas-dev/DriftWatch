/**
 * Migration runner, wire-compatible with golang-migrate's postgres driver.
 *
 * It reads the same `migrations/NNN_name.up.sql` files and tracks state in the
 * same `schema_migrations (version bigint primary key, dirty boolean)` table
 * that golang-migrate used, holding a single row for the current version. That
 * compatibility is deliberate: an already-deployed database migrated by the Go
 * binary must not re-run 001 and blow up on "table already exists".
 *
 * A `dirty` row means a previous run failed halfway. Like golang-migrate, we
 * refuse to continue and require a human to inspect and clear it.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import { logger } from '../logger.js';

const { Client } = pg;

/** Arbitrary but fixed key so concurrent boots serialize on the same lock. */
const ADVISORY_LOCK_KEY = 4_119_872_331;

interface Migration {
	version: number;
	name: string;
	file: string;
}

export async function runMigrations(
	databaseUrl: string,
	migrationsDir: string
): Promise<void> {
	const migrations = await loadMigrations(migrationsDir);
	if (migrations.length === 0) {
		throw new Error(`no .up.sql migrations found in ${migrationsDir}`);
	}

	const client = new Client({ connectionString: databaseUrl });
	await client.connect();

	try {
		await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
		try {
			await client.query(
				`CREATE TABLE IF NOT EXISTS schema_migrations (
					version BIGINT NOT NULL PRIMARY KEY,
					dirty BOOLEAN NOT NULL
				)`
			);

			const { rows } = await client.query<{ version: string; dirty: boolean }>(
				'SELECT version, dirty FROM schema_migrations LIMIT 1'
			);
			const current = rows[0];
			if (current?.dirty) {
				throw new Error(
					`database is dirty at version ${current.version}; ` +
						'fix the schema by hand, then UPDATE schema_migrations SET dirty = false'
				);
			}
			const currentVersion = current ? Number(current.version) : 0;

			const pending = migrations.filter((m) => m.version > currentVersion);
			if (pending.length === 0) return;

			for (const m of pending) {
				const sql = await readFile(m.file, 'utf8');
				await setVersion(client, m.version, true);
				try {
					await client.query('BEGIN');
					await client.query(sql);
					await client.query('COMMIT');
				} catch (err) {
					await client.query('ROLLBACK').catch(() => undefined);
					throw new Error(
						`migration ${m.version}_${m.name} failed: ${(err as Error).message}`
					);
				}
				await setVersion(client, m.version, false);
				logger.info('migration applied', { version: m.version, name: m.name });
			}
		} finally {
			await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
		}
	} finally {
		await client.end();
	}
}

async function setVersion(
	client: pg.Client,
	version: number,
	dirty: boolean
): Promise<void> {
	// golang-migrate keeps exactly one row and rewrites it on every step.
	await client.query('DELETE FROM schema_migrations');
	await client.query('INSERT INTO schema_migrations (version, dirty) VALUES ($1, $2)', [
		version,
		dirty
	]);
}

async function loadMigrations(dir: string): Promise<Migration[]> {
	const entries = await readdir(dir);
	const out: Migration[] = [];

	for (const entry of entries) {
		if (!entry.endsWith('.up.sql')) continue;
		const match = /^(\d+)_(.+)\.up\.sql$/.exec(entry);
		if (!match) {
			logger.warn('skipping unrecognized migration filename', { file: entry });
			continue;
		}
		out.push({
			version: Number(match[1]),
			name: match[2] as string,
			file: path.join(dir, entry)
		});
	}

	return out.sort((a, b) => a.version - b.version);
}
