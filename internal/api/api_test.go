package api_test

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	_ "modernc.org/sqlite"

	"fetchfido/internal/api"
	"fetchfido/internal/auth"
	"fetchfido/internal/store"
)

func newServer(t *testing.T, cfg api.Config) *httptest.Server {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	st := store.New(db)
	if err := st.Init(t.Context()); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(api.New(st, cfg, nil))
	t.Cleanup(srv.Close)
	return srv
}

// creds is what web/js/kdf.js would send for an email and password. The
// handlers only check the key's shape, so any 32 bytes stand in for the
// derivation; the real vector is pinned in internal/auth.
func creds(email, password string) map[string]any {
	sum := sha256.Sum256([]byte(strings.ToLower(email) + "\x00" + password))
	return map[string]any{"email": email, "kdf": auth.KDF, "key": base64.RawURLEncoding.EncodeToString(sum[:])}
}

// client is a browser-ish caller: keeps cookies, sends an Origin.
type client struct {
	t    *testing.T
	base string
	jar  []*http.Cookie
	hdr  map[string]string
}

func newClient(t *testing.T, srv *httptest.Server) *client {
	return &client{t: t, base: srv.URL, hdr: map[string]string{}}
}

func (c *client) do(method, path string, body any) (*http.Response, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Origin", c.base)
	for k, v := range c.hdr {
		req.Header.Set(k, v)
	}
	for _, ck := range c.jar {
		req.AddCookie(ck)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	if cs := res.Cookies(); len(cs) > 0 {
		c.jar = cs
	}
	var out map[string]any
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		_ = json.Unmarshal(raw, &out)
	} else {
		out = map[string]any{"_body": string(raw)}
	}
	return res, out
}

func pos(id string, ts int64, lat, lon float64) map[string]any {
	return map[string]any{"deviceId": id, "ts": ts, "lat": lat, "lon": lon, "link": "mesh",
		"alt": nil, "speed": nil, "heading": nil, "sats": 7, "rssi": -95, "snr": 6.5, "hops": 0}
}

func want(t *testing.T, res *http.Response, status int, out map[string]any) {
	t.Helper()
	if res.StatusCode != status {
		t.Fatalf("%s %s: want %d got %d: %v", res.Request.Method, res.Request.URL.Path, status, res.StatusCode, out)
	}
}

// San Francisco: never the real device's location.
const sfLat, sfLon = 37.7749, -122.4194

func TestSingleModeIsOpenAndStoresEverything(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeSingle, RetentionDays: 30})
	c := newClient(t, srv)

	res, out := c.do("GET", "/api/v1/me", nil)
	want(t, res, 200, out)
	if out["mode"] != "single" || out["authenticated"] != true || out["tokenRequired"] != false {
		t.Fatalf("me: %v", out)
	}

	now := time.Now().Unix()
	res, out = c.do("POST", "/api/v1/sync", map[string]any{"positions": []any{
		pos("!9ea0eaac", now-60, sfLat, sfLon),
		pos("!9ea0eaac", now-30, sfLat+0.0001, sfLon),
		pos("!9ea0eaac", now-30, sfLat+0.0001, sfLon), // duplicate within the batch
		pos("!00000001", now-10, 0, 0),                // no fix: invalid
	}})
	want(t, res, 200, out)
	if out["accepted"] != 2.0 || out["duplicates"] != 1.0 || out["invalid"] != 1.0 {
		t.Fatalf("sync: %v", out)
	}

	// Resending is idempotent.
	res, out = c.do("POST", "/api/v1/sync", map[string]any{"positions": []any{pos("!9ea0eaac", now-60, sfLat, sfLon)}})
	want(t, res, 200, out)
	if out["accepted"] != 0.0 || out["duplicates"] != 1.0 {
		t.Fatalf("resync: %v", out)
	}

	res, out = c.do("GET", "/api/v1/positions?device=!9ea0eaac", nil)
	want(t, res, 200, out)
	ps := out["positions"].([]any)
	if len(ps) != 2 {
		t.Fatalf("positions: %v", out)
	}
	first := ps[0].(map[string]any)
	if first["ts"] != float64(now-30) || first["rssi"] != -95.0 || first["alt"] != nil {
		t.Fatalf("newest first with telemetry intact: %v", first)
	}

	res, out = c.do("GET", "/api/v1/export", nil)
	want(t, res, 200, out)
	body := out["_body"].(string)
	if !strings.HasPrefix(body, "device_id,timestamp_utc,lat,lon") || strings.Count(body, "\n") != 3 {
		t.Fatalf("csv: %q", body)
	}
	if !strings.Contains(res.Header.Get("Content-Disposition"), "fetchfido-") {
		t.Fatalf("disposition: %q", res.Header.Get("Content-Disposition"))
	}
}

func TestSingleModeAccessToken(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeSingle, AccessToken: "s3cret-token"})
	c := newClient(t, srv)

	res, out := c.do("GET", "/api/v1/devices", nil)
	want(t, res, 401, out)

	c.hdr["Authorization"] = "Bearer s3cret-token"
	res, out = c.do("GET", "/api/v1/devices", nil)
	want(t, res, 200, out)
	delete(c.hdr, "Authorization")

	res, out = c.do("POST", "/api/v1/auth/login", map[string]any{"token": "wrong"})
	want(t, res, 401, out)
	res, out = c.do("POST", "/api/v1/auth/login", map[string]any{"token": "s3cret-token"})
	want(t, res, 200, out)
	// Cookie now carries the token.
	res, out = c.do("GET", "/api/v1/me", nil)
	want(t, res, 200, out)
	if out["authenticated"] != true || out["tokenRequired"] != true {
		t.Fatalf("me after login: %v", out)
	}
	res, out = c.do("POST", "/api/v1/auth/logout", nil)
	want(t, res, 200, out)
	res, out = c.do("GET", "/api/v1/devices", nil)
	want(t, res, 401, out)
}

func TestAccountsModeIsolatesTenantsAndRejectsUnclaimed(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeAccounts, Registration: true, SecureCookies: false})
	alice := newClient(t, srv)
	bob := newClient(t, srv)

	res, out := alice.do("GET", "/api/v1/devices", nil)
	want(t, res, 401, out)

	res, out = alice.do("POST", "/api/v1/auth/register", map[string]any{"email": "Alice@Example.com", "kdf": auth.KDF, "key": "dG9vIHNob3J0"})
	want(t, res, 400, out)
	res, out = alice.do("POST", "/api/v1/auth/register", map[string]any{"email": "Alice@Example.com", "kdf": "argon2id-v9", "key": creds("a", "b")["key"]})
	want(t, res, 400, out)
	res, out = alice.do("POST", "/api/v1/auth/register", map[string]any{"email": "Alice@Example.com", "password": "correct horse battery"})
	want(t, res, 400, out) // the old protocol: a raw password is never accepted
	res, out = alice.do("POST", "/api/v1/auth/register", creds("Alice@Example.com", "correct horse battery"))
	want(t, res, 201, out)
	if out["email"] != "alice@example.com" {
		t.Fatalf("email normalised: %v", out)
	}
	res, out = bob.do("POST", "/api/v1/auth/register", creds("alice@example.com", "another long password"))
	want(t, res, 409, out)
	res, out = bob.do("POST", "/api/v1/auth/register", creds("bob@example.com", "another long password"))
	want(t, res, 201, out)

	// Unclaimed nodes are not stored, and the client is told which.
	now := time.Now().Unix()
	res, out = alice.do("POST", "/api/v1/sync", map[string]any{"positions": []any{pos("!9ea0eaac", now-60, sfLat, sfLon)}})
	want(t, res, 200, out)
	if out["accepted"] != 0.0 || fmt.Sprint(out["unclaimed"]) != "[!9ea0eaac]" {
		t.Fatalf("unclaimed: %v", out)
	}

	res, out = alice.do("POST", "/api/v1/devices/claim", map[string]any{"nodeId": "!9EA0EAAC", "name": "Fido", "shortName": "FIDO", "colour": "#f80"})
	want(t, res, 200, out)
	res, out = alice.do("POST", "/api/v1/devices/claim", map[string]any{"nodeId": "nonsense", "name": "x"})
	want(t, res, 400, out)

	res, out = alice.do("POST", "/api/v1/sync", map[string]any{"positions": []any{
		pos("!9ea0eaac", now-60, sfLat, sfLon), pos("!9ea0eaac", now-30, sfLat, sfLon+0.0001)}})
	want(t, res, 200, out)
	if out["accepted"] != 2.0 {
		t.Fatalf("claimed sync: %v", out)
	}

	// Bob claims the same node ID. He sees only what his own phone uploads.
	res, out = bob.do("POST", "/api/v1/devices/claim", map[string]any{"nodeId": "!9ea0eaac", "name": "Not Fido"})
	want(t, res, 200, out)
	res, out = bob.do("GET", "/api/v1/positions", nil)
	want(t, res, 200, out)
	if n := len(out["positions"].([]any)); n != 0 {
		t.Fatalf("bob sees alice's positions: %d", n)
	}
	res, out = alice.do("GET", "/api/v1/positions", nil)
	want(t, res, 200, out)
	if n := len(out["positions"].([]any)); n != 2 {
		t.Fatalf("alice positions: %d", n)
	}
	res, out = alice.do("GET", "/api/v1/devices", nil)
	want(t, res, 200, out)
	d := out["devices"].([]any)[0].(map[string]any)
	if d["name"] != "Fido" || d["claimKind"] != "node_id" {
		t.Fatalf("device: %v", d)
	}

	// Release deletes the track too.
	res, out = alice.do("DELETE", "/api/v1/devices/!9ea0eaac", nil)
	want(t, res, 200, out)
	res, out = alice.do("GET", "/api/v1/positions", nil)
	want(t, res, 200, out)
	if n := len(out["positions"].([]any)); n != 0 {
		t.Fatalf("positions survive release: %d", n)
	}

	// Login round trip, including the wrong password.
	fresh := newClient(t, srv)
	res, out = fresh.do("POST", "/api/v1/auth/login", creds("alice@example.com", "wrong password here"))
	want(t, res, 401, out)
	res, out = fresh.do("POST", "/api/v1/auth/login", creds("nobody@example.com", "wrong password here"))
	want(t, res, 401, out)
	res, out = fresh.do("POST", "/api/v1/auth/login", creds("ALICE@example.com", "correct horse battery"))
	want(t, res, 200, out)
	res, out = fresh.do("GET", "/api/v1/me", nil)
	want(t, res, 200, out)
	if out["email"] != "alice@example.com" {
		t.Fatalf("me: %v", out)
	}
	for _, ck := range fresh.jar {
		if ck.Name == "ff_session" && (!ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode) {
			t.Fatalf("cookie flags: %+v", ck)
		}
	}
}

func TestRegistrationCanBeClosed(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeAccounts, Registration: false})
	c := newClient(t, srv)
	res, out := c.do("POST", "/api/v1/auth/register", creds("a@b.co", "long enough password"))
	want(t, res, 403, out)
	res, out = c.do("GET", "/api/v1/me", nil)
	want(t, res, 200, out)
	if out["registration"] != false {
		t.Fatalf("me: %v", out)
	}
}

func TestCrossSiteWritesAreRefused(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeSingle})
	c := newClient(t, srv)
	c.hdr["Origin"] = "https://evil.example"
	res, out := c.do("POST", "/api/v1/sync", map[string]any{"positions": []any{}})
	want(t, res, 403, out)
	c.hdr["Origin"] = c.base
	c.hdr["Sec-Fetch-Site"] = "cross-site"
	res, out = c.do("POST", "/api/v1/sync", map[string]any{"positions": []any{}})
	want(t, res, 403, out)
	delete(c.hdr, "Sec-Fetch-Site")
	res, out = c.do("POST", "/api/v1/sync", map[string]any{"positions": []any{}})
	want(t, res, 200, out)
	// Reads are not CSRF-relevant and are allowed.
	c.hdr["Origin"] = "https://evil.example"
	res, out = c.do("GET", "/api/v1/health", nil)
	want(t, res, 200, out)
}

func TestSyncLimitsAndContentType(t *testing.T) {
	srv := newServer(t, api.Config{Mode: api.ModeSingle})
	c := newClient(t, srv)
	big := make([]any, 1001)
	for i := range big {
		big[i] = pos("!9ea0eaac", int64(i+1), sfLat, sfLon)
	}
	res, out := c.do("POST", "/api/v1/sync", map[string]any{"positions": big})
	want(t, res, 413, out)

	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/sync", strings.NewReader(`{"positions":[]}`))
	req.Header.Set("Content-Type", "text/plain")
	res2, _ := http.DefaultClient.Do(req)
	if res2.StatusCode != 400 {
		t.Fatalf("content type: %d", res2.StatusCode)
	}
}

// The static handler's headers. Referrer-Policy matters more than it looks:
// OpenStreetMap serves an "access blocked" tile to requests without a Referer,
// and no-referrer here took the map down on the first hosted deploy.
func TestStaticHeaders(t *testing.T) {
	web := fstest.MapFS{
		"web/index.html":        {Data: []byte("<!doctype html>")},
		"web/help.html":         {Data: []byte("<!doctype html><title>help</title>")},
		"web/vendor/leaflet.js": {Data: []byte("// leaflet")},
	}
	db, err := sql.Open("sqlite", "file::memory:")
	if err != nil {
		t.Fatal(err)
	}
	st := store.New(db)
	if err := st.Init(t.Context()); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(api.New(st, api.Config{Mode: api.ModeSingle}, web))
	t.Cleanup(srv.Close)

	// /help is served extensionless on both deployments; see staticHandler.
	res, err := http.Get(srv.URL + "/help")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(body), "<title>help</title>") || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("/help: %d %q %q", res.StatusCode, res.Header.Get("Content-Type"), body)
	}

	for path, cache := range map[string]string{"/": "no-cache, must-revalidate", "/vendor/leaflet.js": "public, max-age=31536000, immutable"} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		want := map[string]string{
			"Content-Security-Policy":    "frame-ancestors 'none'",
			"X-Content-Type-Options":     "nosniff",
			"Referrer-Policy":            "strict-origin-when-cross-origin",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cache-Control":              cache,
		}
		for k, v := range want {
			if got := res.Header.Get(k); got != v {
				t.Errorf("%s %s = %q, want %q", path, k, got, v)
			}
		}
	}
}
