import { afterEach, describe, expect, it } from 'vitest';

import { cryptoEnabled, decrypt, encrypt, initCrypto } from './crypto.js';

afterEach(() => initCrypto('')); // reset the process-wide key between tests

describe('crypto', () => {
	it('round-trips a secret', () => {
		initCrypto('a-test-passphrase-at-least-long-enough');

		const secret = 'ghp_exampletoken1234567890';
		const ct = encrypt(secret);

		expect(cryptoEnabled()).toBe(true);
		expect(ct).not.toBe(secret);
		expect(ct.startsWith('enc:v1:')).toBe(true);
		expect(decrypt(ct)).toBe(secret);
	});

	it('produces a different ciphertext each time (random nonce)', () => {
		initCrypto('some-key');
		expect(encrypt('same-input')).not.toBe(encrypt('same-input'));
	});

	it('passes plaintext through when disabled', () => {
		initCrypto('');

		expect(cryptoEnabled()).toBe(false);
		expect(encrypt('hello')).toBe('hello');
		expect(decrypt('hello')).toBe('hello');
	});

	it('maps empty input to empty output', () => {
		initCrypto('some-key');
		expect(encrypt('')).toBe('');
	});

	it('fails to decrypt with the wrong key', () => {
		initCrypto('first-key');
		const ct = encrypt('secret-value');

		initCrypto('different-key');
		expect(() => decrypt(ct)).toThrow();
	});

	it('refuses to decrypt an encrypted value with no key configured', () => {
		initCrypto('first-key');
		const ct = encrypt('secret-value');

		initCrypto('');
		expect(() => decrypt(ct)).toThrow(/ENCRYPTION_KEY required/);
	});

	it('rejects a truncated ciphertext', () => {
		initCrypto('some-key');
		expect(() => decrypt('enc:v1:' + Buffer.from('short').toString('base64'))).toThrow(
			/too short/
		);
	});
});
