/**
 * stableStringify serializes a value with object keys sorted recursively, so
 * the same logical state always produces the same string — and therefore the
 * same SHA-256 state hash.
 *
 * This matters because the scheduler short-circuits a scan when the hash of the
 * pushed live state is unchanged. Plain JSON.stringify preserves insertion
 * order, so an agent that enumerated a container's env vars in a different
 * order would produce a different hash for identical state and trigger a
 * pointless rescan. (Go's encoding/json got this for free: it sorts map keys.)
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== 'object') return value;
	if (value instanceof Date) return value.toISOString();

	const src = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(src).sort()) {
		out[key] = sortKeys(src[key]);
	}
	return out;
}
