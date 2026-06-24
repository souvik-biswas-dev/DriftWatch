/**
 * Encrypts small user secrets (GitHub tokens) at rest with AES-256-GCM. The
 * process-wide key is derived from ENCRYPTION_KEY via SHA-256 and initialized
 * once at startup.
 *
 * If no key is configured, encrypt() returns the plaintext unchanged so local
 * dev works without setup — but production multi-user deploys MUST set
 * ENCRYPTION_KEY so users' tokens aren't stored in the clear. Values produced
 * when encryption is enabled carry the "enc:v1:" prefix; decrypt() treats
 * anything without that prefix as legacy plaintext and returns it as-is.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes
} from 'node:crypto';

const PREFIX = 'enc:v1:';
const NONCE_BYTES = 12; // AES-GCM standard nonce, matches Go's gcm.NonceSize()
const TAG_BYTES = 16;

/** The 32-byte AES key, or null when encryption is disabled. */
let key: Buffer | null = null;

/**
 * initCrypto derives the encryption key from a passphrase. An empty passphrase
 * disables encryption (plaintext fallback).
 */
export function initCrypto(passphrase: string): void {
	key = passphrase === '' ? null : createHash('sha256').update(passphrase).digest();
}

/** Reports whether an encryption key is configured. */
export function cryptoEnabled(): boolean {
	return key !== null;
}

/**
 * encrypt returns an "enc:v1:"-prefixed ciphertext, or the plaintext unchanged
 * when encryption is disabled. Empty input returns empty.
 */
export function encrypt(plaintext: string): string {
	if (plaintext === '') return '';
	if (key === null) return plaintext;

	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	// Go's gcm.Seal appends the auth tag to the ciphertext and prefixes the
	// nonce; lay the bytes out the same way so both implementations can read
	// each other's values.
	const packed = Buffer.concat([nonce, ct, cipher.getAuthTag()]);
	return PREFIX + packed.toString('base64');
}

/**
 * decrypt reverses encrypt. Values without the "enc:v1:" prefix are assumed to
 * be plaintext (legacy / encryption-disabled) and returned unchanged.
 */
export function decrypt(s: string): string {
	if (!s.startsWith(PREFIX)) return s;
	if (key === null) {
		throw new Error('crypto: ENCRYPTION_KEY required to decrypt a stored secret');
	}

	const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
	if (raw.length < NONCE_BYTES + TAG_BYTES) {
		throw new Error('crypto: ciphertext too short');
	}

	const nonce = raw.subarray(0, NONCE_BYTES);
	const tag = raw.subarray(raw.length - TAG_BYTES);
	const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);

	const decipher = createDecipheriv('aes-256-gcm', key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
