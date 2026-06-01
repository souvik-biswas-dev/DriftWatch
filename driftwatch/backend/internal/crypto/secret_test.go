package crypto

import "testing"

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	Init("a-test-passphrase-at-least-long-enough")
	defer Init("") // reset global state for other tests

	const secret = "ghp_exampletoken1234567890"
	ct, err := Encrypt(secret)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if ct == secret {
		t.Fatal("ciphertext should not equal plaintext when encryption is enabled")
	}
	if len(ct) < 7 || ct[:7] != "enc:v1:" {
		t.Fatalf("expected enc:v1: prefix, got %q", ct)
	}

	pt, err := Decrypt(ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if pt != secret {
		t.Fatalf("round-trip mismatch: got %q want %q", pt, secret)
	}
}

func TestEncrypt_DisabledIsPlaintext(t *testing.T) {
	Init("") // disabled

	ct, err := Encrypt("hello")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if ct != "hello" {
		t.Fatalf("disabled encryption should pass through plaintext, got %q", ct)
	}

	pt, err := Decrypt("hello")
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if pt != "hello" {
		t.Fatalf("expected passthrough, got %q", pt)
	}
}

func TestEncrypt_EmptyIsEmpty(t *testing.T) {
	Init("some-key")
	defer Init("")
	ct, err := Encrypt("")
	if err != nil {
		t.Fatalf("encrypt empty: %v", err)
	}
	if ct != "" {
		t.Fatalf("empty input should yield empty output, got %q", ct)
	}
}

func TestDecrypt_WrongKeyFails(t *testing.T) {
	Init("first-key")
	ct, err := Encrypt("secret-value")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	Init("different-key")
	defer Init("")
	if _, err := Decrypt(ct); err == nil {
		t.Fatal("decrypt with wrong key should fail")
	}
}
