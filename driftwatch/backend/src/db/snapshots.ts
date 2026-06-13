import type { Queryable } from './pool.js';
import type { Snapshot } from './models.js';

export interface CreateSnapshotParams {
	projectId: string;
	stateHash: string;
	/** Pre-serialized JSON; the columns are JSONB. */
	liveState: string;
	declaredState: string;
}

export async function createSnapshot(
	db: Queryable,
	arg: CreateSnapshotParams
): Promise<Snapshot> {
	const { rows } = await db.query<Snapshot>(
		`INSERT INTO snapshots (project_id, state_hash, live_state, declared_state)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, project_id, state_hash, live_state, declared_state, taken_at`,
		[arg.projectId, arg.stateHash, arg.liveState, arg.declaredState]
	);
	return rows[0]!;
}

export async function getLatestSnapshotByProject(
	db: Queryable,
	projectId: string
): Promise<Snapshot | null> {
	const { rows } = await db.query<Snapshot>(
		`SELECT id, project_id, state_hash, live_state, declared_state, taken_at
		 FROM snapshots
		 WHERE project_id = $1
		 ORDER BY taken_at DESC
		 LIMIT 1`,
		[projectId]
	);
	return rows[0] ?? null;
}
