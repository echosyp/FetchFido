package auth_test

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"

	"fetchfido/internal/auth"
)

// The protocol vector shared with web/test/kdf.test.mjs and computed
// independently with Python's hashlib on 2026-10-18. The server never runs
// PBKDF2 itself; this test pins what the client must produce so the two
// sides cannot drift apart unnoticed.
const (
	vectorEmail    = "alice@example.com"
	vectorPassword = "correct horse battery"
	vectorKey      = "FbRV4S3euJ0g7iQp-_cgZ_u4tLgodJLnRVrcS7TsbLA"
)

func TestKDFVector(t *testing.T) {
	salt := sha256.Sum256([]byte("fetchfido-kdf-v1:" + vectorEmail))
	key, err := pbkdf2.Key(sha256.New, vectorPassword, salt[:], 600_000, auth.KeyLen)
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(key); got != vectorKey {
		t.Fatalf("vector drifted: %s", got)
	}
	if auth.KDF != "pbkdf2-sha256-v1" {
		t.Fatalf("KDF name changed without a new vector: %s", auth.KDF)
	}
}

func TestKeyRoundTrip(t *testing.T) {
	key, err := auth.DecodeKey(vectorKey)
	if err != nil {
		t.Fatal(err)
	}
	h, err := auth.HashKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "sha256$") || strings.Count(h, "$") != 2 {
		t.Fatalf("format: %s", h)
	}
	if !auth.CheckKey(key, h) {
		t.Fatal("match expected")
	}
	other := append([]byte(nil), key...)
	other[0] ^= 1
	if auth.CheckKey(other, h) {
		t.Fatal("mismatch expected")
	}
	h2, _ := auth.HashKey(key)
	if h2 == h {
		t.Fatal("salts must differ between hashes of the same key")
	}
	if auth.CheckKey(key, "garbage") || auth.CheckKey(key, "") || auth.CheckKey(key, "sha256$AA$AA") {
		t.Fatal("malformed hash must never verify")
	}
	for _, bad := range []string{"", "short", vectorKey + "AA", "not base64url!"} {
		if _, err := auth.DecodeKey(bad); err == nil {
			t.Fatalf("DecodeKey(%q) accepted", bad)
		}
	}
}

func TestTokens(t *testing.T) {
	tok, dig, err := auth.NewToken()
	if err != nil || len(tok) < 40 || dig != auth.Digest(tok) {
		t.Fatalf("token: %q %q %v", tok, dig, err)
	}
	tok2, _, _ := auth.NewToken()
	if tok == tok2 {
		t.Fatal("tokens must differ")
	}
	if !auth.Equal("a", "a") || auth.Equal("a", "b") {
		t.Fatal("Equal")
	}
}
