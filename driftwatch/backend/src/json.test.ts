import { describe, expect, it } from 'vitest';

import { stableStringify } from './json.js';

describe('stableStringify', () => {
	it('is insensitive to key insertion order', () => {
		const a = { containers: [{ name: 'web', env: { B: '2', A: '1' } }] };
		const b = { containers: [{ env: { A: '1', B: '2' }, name: 'web' }] };
		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it('preserves array order', () => {
		expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]));
	});

	it('handles nulls and scalars', () => {
		expect(stableStringify({ a: null, b: 1, c: 'x' })).toBe('{"a":null,"b":1,"c":"x"}');
	});
});
