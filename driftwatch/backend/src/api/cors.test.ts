import { describe, expect, it } from 'vitest';

import { isPagesPreview } from './cors.js';

describe('isPagesPreview', () => {
	const allowed = 'https://driftwatch.pages.dev';

	it('accepts a preview subdomain of the configured Pages project', () => {
		expect(isPagesPreview('https://247bc5d9.driftwatch.pages.dev', allowed)).toBe(true);
	});

	it('rejects a different Pages project', () => {
		expect(isPagesPreview('https://evil.pages.dev', allowed)).toBe(false);
		expect(isPagesPreview('https://x.evil.pages.dev', allowed)).toBe(false);
	});

	it('rejects a lookalike suffix without the dot boundary', () => {
		expect(isPagesPreview('https://notdriftwatch.pages.dev', allowed)).toBe(false);
	});

	it('rejects non-https and non-Pages origins', () => {
		expect(isPagesPreview('http://x.driftwatch.pages.dev', allowed)).toBe(false);
		expect(isPagesPreview('https://x.example.com', 'https://example.com')).toBe(false);
	});
});
