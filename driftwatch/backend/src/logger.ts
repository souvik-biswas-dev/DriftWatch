/**
 * Structured JSON logger, the Node equivalent of Go's log/slog.
 *
 * Usage mirrors the Go original:
 *
 *   logger.info('scan complete', { project_id: id, drift_count: 3 });
 *   const log = logger.with({ project_id: id });
 *   log.error('fetch declared config', { error: err });
 *
 * Errors passed in the fields object are flattened to their message (and stack
 * on error level) since Error does not survive JSON.stringify.
 */

export type Fields = Record<string, unknown>;

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

function normalize(value: unknown): unknown {
	if (value instanceof Error) return value.message;
	return value;
}

function normalizeFields(fields: Fields | undefined): Fields {
	if (!fields) return {};
	const out: Fields = {};
	for (const [key, value] of Object.entries(fields)) {
		out[key] = normalize(value);
	}
	return out;
}

export interface Logger {
	debug(msg: string, fields?: Fields): void;
	info(msg: string, fields?: Fields): void;
	warn(msg: string, fields?: Fields): void;
	error(msg: string, fields?: Fields): void;
	/** Returns a child logger that stamps `bound` onto every record. */
	with(bound: Fields): Logger;
}

function make(bound: Fields): Logger {
	const emit = (level: Level, msg: string, fields?: Fields): void => {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
		const record = {
			time: new Date().toISOString(),
			level,
			msg,
			...bound,
			...normalizeFields(fields)
		};
		const line = JSON.stringify(record);
		if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
		else process.stdout.write(line + '\n');
	};

	return {
		debug: (msg, fields) => emit('debug', msg, fields),
		info: (msg, fields) => emit('info', msg, fields),
		warn: (msg, fields) => emit('warn', msg, fields),
		error: (msg, fields) => emit('error', msg, fields),
		with: (extra) => make({ ...bound, ...normalizeFields(extra) })
	};
}

export const logger: Logger = make({});
