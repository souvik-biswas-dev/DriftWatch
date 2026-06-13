import type { Queryable } from './pool.js';
import type { DriftEventRow } from './models.js';

const COLUMNS = `id, project_id, snapshot_id, drift_type, container_name,
	live_value, declared_value, severity, ai_summary, fix_command,
	alerted_at, resolved_at, created_at`;

export interface CreateDriftEventParams {
	projectId: string;
	snapshotId: string;
	driftType: string;
	containerName: string;
	liveValue: string | null;
	declaredValue: string | null;
	severity: string;
	aiSummary: string | null;
	fixCommand: string | null;
}

export async function createDriftEvent(
	db: Queryable,
	arg: CreateDriftEventParams
): Promise<DriftEventRow> {
	const { rows } = await db.query<DriftEventRow>(
		`INSERT INTO drift_events (
			project_id, snapshot_id, drift_type, container_name,
			live_value, declared_value, severity, ai_summary, fix_command
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING ${COLUMNS}`,
		[
			arg.projectId,
			arg.snapshotId,
			arg.driftType,
			arg.containerName,
			arg.liveValue,
			arg.declaredValue,
			arg.severity,
			arg.aiSummary,
			arg.fixCommand
		]
	);
	return rows[0]!;
}

export async function getDriftEventById(
	db: Queryable,
	id: string
): Promise<DriftEventRow | null> {
	const { rows } = await db.query<DriftEventRow>(
		`SELECT ${COLUMNS} FROM drift_events WHERE id = $1`,
		[id]
	);
	return rows[0] ?? null;
}

export async function listDriftEventsByProject(
	db: Queryable,
	projectId: string
): Promise<DriftEventRow[]> {
	const { rows } = await db.query<DriftEventRow>(
		`SELECT ${COLUMNS}
		 FROM drift_events
		 WHERE project_id = $1
		 ORDER BY created_at DESC
		 LIMIT 50`,
		[projectId]
	);
	return rows;
}

export async function resolveDriftEvent(db: Queryable, id: string): Promise<void> {
	await db.query('UPDATE drift_events SET resolved_at = now() WHERE id = $1', [id]);
}

export async function markDriftEventAlerted(db: Queryable, id: string): Promise<void> {
	await db.query('UPDATE drift_events SET alerted_at = now() WHERE id = $1', [id]);
}

export async function updateDriftEventAnalysis(
	db: Queryable,
	id: string,
	aiSummary: string | null,
	fixCommand: string | null
): Promise<void> {
	await db.query(
		'UPDATE drift_events SET ai_summary = $2, fix_command = $3 WHERE id = $1',
		[id, aiSummary, fixCommand]
	);
}

/**
 * Returns true if an identical unresolved drift event already exists for this
 * project. Used to prevent duplicate events piling up on every scan cycle.
 */
export async function hasOpenDriftEvent(
	db: Queryable,
	projectId: string,
	containerName: string,
	driftType: string
): Promise<boolean> {
	const { rows } = await db.query<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM drift_events
			WHERE project_id = $1
			  AND container_name = $2
			  AND drift_type = $3
			  AND resolved_at IS NULL
		 )`,
		[projectId, containerName, driftType]
	);
	return rows[0]?.exists ?? false;
}
