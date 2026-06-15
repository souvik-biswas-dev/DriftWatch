import pg from 'pg';

const { Pool } = pg;

/**
 * Anything a query can run on: the pool itself or a checked-out client inside a
 * transaction. Mirrors the DBTX interface the sqlc-generated Go code used.
 */
export interface Queryable {
	query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		values?: unknown[]
	): Promise<pg.QueryResult<R>>;
}

export function createPool(databaseUrl: string): pg.Pool {
	return new Pool({
		connectionString: databaseUrl,
		max: 10,
		min: 2,
		// Neon (and most managed Postgres) require TLS; the sslmode=require in
		// the connection string is honoured by pg's URL parser.
		idleTimeoutMillis: 5 * 60 * 1000, // MaxConnIdleTime
		maxLifetimeSeconds: 30 * 60, // MaxConnLifetime
		connectionTimeoutMillis: 10_000
	});
}

/** Ping runs a trivial query with a timeout, used by /status and at boot. */
export async function ping(db: Queryable, timeoutMs = 5000): Promise<void> {
	await withTimeout(db.query('SELECT 1'), timeoutMs, 'postgres ping timed out');
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}
