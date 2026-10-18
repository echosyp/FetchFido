// Package auth: password hashing and session tokens, standard library only.
//
// PBKDF2-SHA256 rather than argon2 or bcrypt because it is in the standard
// library (crypto/pbkdf2, Go 1.24) and so builds identically for the native
// binary and the WebAssembly Worker. Cost is recorded in the hash string, so
// it can be raised later without invalidating existing accounts.
package auth

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// DefaultIterations follows the OWASP figure for PBKDF2-SHA256. Pure-Go SHA256
// inside WebAssembly is slow, so a Worker deployment on a tight CPU budget may
// lower this via configuration; the hash string carries whatever was used.
const DefaultIterations = 600_000

const (
	saltLen = 16
	keyLen  = 32
)

// HashPassword returns "pbkdf2-sha256$<iters>$<salt>$<key>", base64url parts.
func HashPassword(password string, iterations int) (string, error) {
	if iterations < 10_000 {
		return "", errors.New("pbkdf2 iterations too low")
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, iterations, keyLen)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iterations, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// CheckPassword reports whether password matches the stored hash. A malformed
// hash is simply a mismatch; it must never be a bypass.
func CheckPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iterations, err := strconv.Atoi(parts[1])
	if err != nil || iterations <= 0 {
		return false
	}
	enc := base64.RawURLEncoding
	salt, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// NewToken returns a random session token for the browser and the digest the
// server stores. Only the digest is persisted, so a leaked database does not
// yield usable sessions.
func NewToken() (token, digest string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, Digest(token), nil
}

// Digest is how a presented token is looked up.
func Digest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Equal compares two secrets in constant time.
func Equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
