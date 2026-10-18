// Package auth: password verification and session tokens, standard library only.
//
// The slow part of password hashing runs in the browser, not here. The client
// derives a 32-byte key with PBKDF2-SHA256 (600,000 rounds, web/js/kdf.js) and
// sends that instead of the password; the server stores a salted SHA-256 of
// the key. Verifying costs the server one hash. The two deployments forced
// this: the hosted version is a Cloudflare Worker on a 10 ms CPU budget, where
// 600,000 rounds in WebAssembly take 590 ms (measured 2026-10-18), and even a
// native hash would not fit. Security is unchanged -- an attacker holding the
// database must still pay the full PBKDF2 cost for every guess, because the
// stored value is a one-way function of the derived key -- and the derived
// key crosses the wire exactly as the password would have.
//
// The KDF is versioned by name. Changing its parameters means a new name,
// and the server records which one each account used.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// KDF names the client-side derivation the server accepts. web/js/kdf.js
// implements it: salt = SHA-256("fetchfido-kdf-v1:" + lowercase trimmed
// email), PBKDF2-SHA256, 600,000 rounds, 32 bytes, base64url without padding.
const KDF = "pbkdf2-sha256-v1"

// KeyLen is the byte length of a derived key.
const KeyLen = 32

const saltLen = 16

var enc = base64.RawURLEncoding

// ErrBadKey is returned for a key that is not KeyLen bytes of base64url.
var ErrBadKey = errors.New("key must be 32 bytes, base64url encoded")

// DecodeKey checks the shape of a client-derived key.
func DecodeKey(s string) ([]byte, error) {
	key, err := enc.DecodeString(s)
	if err != nil || len(key) != KeyLen {
		return nil, ErrBadKey
	}
	return key, nil
}

// HashKey returns what the server stores for a derived key:
// "sha256$<salt>$<digest>", with digest = SHA-256(salt || key). The salt
// means two accounts with the same key still store different values.
func HashKey(key []byte) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return "sha256$" + enc.EncodeToString(salt) + "$" + enc.EncodeToString(digest(salt, key)), nil
}

// CheckKey reports whether key matches the stored hash. A malformed hash is
// simply a mismatch; it must never be a bypass.
func CheckKey(key []byte, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "sha256" {
		return false
	}
	salt, err := enc.DecodeString(parts[1])
	if err != nil {
		return false
	}
	want, err := enc.DecodeString(parts[2])
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(digest(salt, key), want) == 1
}

func digest(salt, key []byte) []byte {
	h := sha256.New()
	h.Write(salt)
	h.Write(key)
	return h.Sum(nil)
}

// NewToken returns a random session token for the browser and the digest the
// server stores. Only the digest is persisted, so a leaked database does not
// yield usable sessions.
func NewToken() (token, digest string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token = enc.EncodeToString(raw)
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
