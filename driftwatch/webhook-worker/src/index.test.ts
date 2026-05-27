import { describe, expect, it } from 'vitest';
import { verifySignature } from './index';

async function hmacHex(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('verifySignature', () => {
	const secret = 'test-secret-1234';
	const body = '{"ref":"refs/heads/main","repository":{"full_name":"acme/widgets"}}';

	it('accepts a correctly signed body', async () => {
		const hex = await hmacHex(secret, body);
		expect(await verifySignature(secret, body, `sha256=${hex}`)).toBe(true);
	});

	it('accepts uppercase hex in header (case-insensitive)', async () => {
		const hex = (await hmacHex(secret, body)).toUpperCase();
		expect(await verifySignature(secret, body, `sha256=${hex}`)).toBe(true);
	});

	it('rejects when the body has been tampered with', async () => {
		const hex = await hmacHex(secret, body);
		expect(await verifySignature(secret, body + 'X', `sha256=${hex}`)).toBe(false);
	});

	it('rejects when signed with a different secret', async () => {
		const hex = await hmacHex('attacker-secret', body);
		expect(await verifySignature(secret, body, `sha256=${hex}`)).toBe(false);
	});

	it('rejects a missing header', async () => {
		expect(await verifySignature(secret, body, null)).toBe(false);
	});

	it('rejects a header missing the sha256= prefix', async () => {
		const hex = await hmacHex(secret, body);
		expect(await verifySignature(secret, body, hex)).toBe(false);
	});

	it('rejects a header with the wrong algorithm prefix', async () => {
		const hex = await hmacHex(secret, body);
		expect(await verifySignature(secret, body, `sha1=${hex}`)).toBe(false);
	});

	it('rejects a header containing non-hex characters', async () => {
		expect(
			await verifySignature(secret, body, 'sha256=' + 'z'.repeat(64))
		).toBe(false);
	});

	it('rejects a header with the wrong length', async () => {
		expect(await verifySignature(secret, body, 'sha256=deadbeef')).toBe(false);
	});

	it('rejects an empty secret regardless of header', async () => {
		const hex = await hmacHex('whatever', body);
		expect(await verifySignature('', body, `sha256=${hex}`)).toBe(false);
	});

	it('produces a different signature when the body changes by one byte', async () => {
		const a = await hmacHex(secret, body);
		const b = await hmacHex(secret, body.slice(0, -1) + '!');
		expect(a).not.toBe(b);
	});
});
