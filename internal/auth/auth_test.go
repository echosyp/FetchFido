package auth_test

import (
	"strings"
	"testing"

	"fetchfido/internal/auth"
)

func TestPasswordRoundTrip(t *testing.T) {
	h, err := auth.HashPassword("correct horse", 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "pbkdf2-sha256$10000$") {
		t.Fatalf("format: %s", h)
	}
	if !auth.CheckPassword("correct horse", h) {
		t.Fatal("match expected")
	}
	if auth.CheckPassword("Correct horse", h) {
		t.Fatal("mismatch expected")
	}
	if auth.CheckPassword("x", "garbage") || auth.CheckPassword("x", "") {
		t.Fatal("malformed hash must never verify")
	}
	if _, err := auth.HashPassword("x", 100); err == nil {
		t.Fatal("too few iterations must be refused")
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
