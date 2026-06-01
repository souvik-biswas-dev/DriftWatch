// Package crypto encrypts small user secrets (GitHub tokens) at rest with
// AES-256-GCM. It uses a process-wide key derived from the ENCRYPTION_KEY env
// var via SHA-256, initialized once at startup.
//
// If no key is configured, Encrypt returns the plaintext unchanged so local dev
// works without setup — but production multi-user deploys MUST set ENCRYPTION_KEY
// so users' tokens aren't stored in the clear. Values produced when encryption
// is enabled carry the "enc:v1:" prefix; Decrypt treats anything without that
// prefix as legacy plaintext and returns it as-is.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

const prefix = "enc:v1:"

// key is the 32-byte AES key, or nil when encryption is disabled.
var key []byte

// Init derives the encryption key from a passphrase. Empty passphrase disables
// encryption (plaintext fallback).
func Init(passphrase string) {
	if passphrase == "" {
		key = nil
		return
	}
	sum := sha256.Sum256([]byte(passphrase))
	key = sum[:]
}

// Enabled reports whether an encryption key is configured.
func Enabled() bool { return key != nil }

// Encrypt returns an "enc:v1:"-prefixed ciphertext, or the plaintext unchanged
// when encryption is disabled. Empty input returns empty.
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	if key == nil {
		return plaintext, nil
	}
	gcm, err := newGCM()
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return prefix + base64.StdEncoding.EncodeToString(ct), nil
}

// Decrypt reverses Encrypt. Values without the "enc:v1:" prefix are assumed to
// be plaintext (legacy / encryption-disabled) and returned unchanged.
func Decrypt(s string) (string, error) {
	if !strings.HasPrefix(s, prefix) {
		return s, nil
	}
	if key == nil {
		return "", errors.New("crypto: ENCRYPTION_KEY required to decrypt a stored secret")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, prefix))
	if err != nil {
		return "", err
	}
	gcm, err := newGCM()
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("crypto: ciphertext too short")
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func newGCM() (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
