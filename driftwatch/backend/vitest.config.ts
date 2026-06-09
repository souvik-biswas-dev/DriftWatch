import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		// Each test file gets its own module registry, which matters for the
		// process-wide encryption key in services/crypto.ts.
		isolate: true
	}
});
