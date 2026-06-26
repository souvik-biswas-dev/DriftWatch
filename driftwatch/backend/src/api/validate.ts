import type { ZodError } from 'zod';

/**
 * Flattens a Zod error into a single human-readable line, standing in for the
 * message Gin's binding validator produced.
 */
export function formatZodError(err: ZodError): string {
	return err.issues
		.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
		.join('; ');
}
