// Package api is the HTTP surface shared by the self-hosted binary and the
// Cloudflare Worker: /api/v1/* as an http.Handler, and the PWA as static files.
//
// Two modes (docs/PRD.md section 11, DESIGN section 6.4):
//
//	single    one tenant, no accounts. The self-host default. An optional
//	          shared access token guards the API when the server is reachable
//	          from beyond a trusted network.
//	accounts  email + password accounts, one tenant each, claiming mandatory.
//	          The hosted version.
//
// Same code either way; the mode is configuration.
package api

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"fetchfido/internal/auth"
	"fetchfido/internal/store"
)

// Mode selects the tenancy model.
type Mode string

const (
	ModeSingle   Mode = "single"
	ModeAccounts Mode = "accounts"
)

// Config is everything the handler needs to know about its deployment.
type Config struct {
	Mode Mode
	// AccessToken, single mode only: when set, every API call must present it
	// as a Bearer token or hold the cookie that POST /auth/login sets.
	AccessToken string
	// Registration, accounts mode: whether POST /auth/register is open.
	Registration bool
	// RetentionDays bounds how long positions are kept. Zero keeps forever,
	// which is the wrong default for anything but a lab.
	RetentionDays int
	// SecureCookies marks session cookies Secure. True whenever the server is
	// reached over https, which is always for the hosted version.
	SecureCookies bool
}

const (
	sessionCookie = "ff_session"
	sessionTTL    = 30 * 24 * time.Hour
	maxBody       = 1 << 20 // 1 MiB; a sync batch of 1000 positions is ~150 KB
	maxBatch      = 1000
)

// Handler serves the API and the PWA.
type Handler struct {
	st  *store.Store
	cfg Config
	mux *http.ServeMux
}

// New builds the handler. web may be nil when static assets are served by
// something else (the Worker's assets binding).
func New(st *store.Store, cfg Config, web fs.FS) *Handler {
	if cfg.Mode == "" {
		cfg.Mode = ModeSingle
	}
	h := &Handler{st: st, cfg: cfg, mux: http.NewServeMux()}
	m := h.mux

	m.HandleFunc("GET /api/v1/health", h.health)
	m.HandleFunc("GET /api/v1/me", h.me)
	m.HandleFunc("POST /api/v1/auth/register", h.register)
	m.HandleFunc("POST /api/v1/auth/login", h.login)
	m.HandleFunc("POST /api/v1/auth/logout", h.logout)

	m.Handle("GET /api/v1/devices", h.tenant(h.devices))
	m.Handle("POST /api/v1/devices/claim", h.tenant(h.claim))
	m.Handle("DELETE /api/v1/devices/{nodeId}", h.tenant(h.release))
	m.Handle("POST /api/v1/sync", h.tenant(h.sync))
	m.Handle("GET /api/v1/positions", h.tenant(h.positions))
	m.Handle("GET /api/v1/export", h.tenant(h.export))

	if web != nil {
		m.Handle("GET /", staticHandler(web))
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !sameOrigin(r) {
			writeErr(w, http.StatusForbidden, "cross-site request refused")
			return
		}
	}
	h.mux.ServeHTTP(w, r)
}

// sameOrigin is the CSRF check. Cookies are SameSite=Lax, which already stops
// cross-site POSTs in current browsers; this makes the refusal explicit and
// covers older ones. A request with no Origin or Sec-Fetch-Site header is a
// non-browser client and is left to the token or session check.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

// ---- identity --------------------------------------------------------------

type principal struct {
	tenantID int64
	email    string
}

type ctxKey struct{}

// resolve finds who is calling, or returns an error to send as 401.
func (h *Handler) resolve(r *http.Request) (principal, error) {
	switch h.cfg.Mode {
	case ModeAccounts:
		c, err := r.Cookie(sessionCookie)
		if err != nil || c.Value == "" {
			return principal{}, errors.New("sign in required")
		}
		u, err := h.st.Session(r.Context(), auth.Digest(c.Value))
		if errors.Is(err, sql.ErrNoRows) {
			return principal{}, errors.New("session expired")
		}
		if err != nil {
			return principal{}, err
		}
		return principal{tenantID: u.TenantID, email: u.Email}, nil
	default:
		if h.cfg.AccessToken == "" {
			return principal{tenantID: store.LocalTenant}, nil
		}
		if tok := bearer(r); tok != "" && auth.Equal(tok, h.cfg.AccessToken) {
			return principal{tenantID: store.LocalTenant}, nil
		}
		if c, err := r.Cookie(sessionCookie); err == nil && auth.Equal(c.Value, h.cfg.AccessToken) {
			return principal{tenantID: store.LocalTenant}, nil
		}
		return principal{}, errors.New("access token required")
	}
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	a := r.Header.Get("Authorization")
	if strings.HasPrefix(a, prefix) {
		return strings.TrimSpace(a[len(prefix):])
	}
	return ""
}

// tenant wraps a handler that needs a resolved tenant.
func (h *Handler) tenant(next func(http.ResponseWriter, *http.Request, principal)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := h.resolve(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, err.Error())
			return
		}
		next(w, r, p)
	})
}

// ---- open endpoints --------------------------------------------------------

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "mode": h.cfg.Mode})
}

// me tells the PWA what kind of server it is talking to and whether it is
// signed in, so the client can show the right controls before anything else.
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{
		"mode":          h.cfg.Mode,
		"registration":  h.cfg.Mode == ModeAccounts && h.cfg.Registration,
		"tokenRequired": h.cfg.Mode == ModeSingle && h.cfg.AccessToken != "",
		"retentionDays": h.cfg.RetentionDays,
		// The client derives the password key itself (web/js/kdf.js) and must
		// use the derivation this server expects; see internal/auth.
		"kdf": auth.KDF,
	}
	p, err := h.resolve(r)
	out["authenticated"] = err == nil
	if err == nil && p.email != "" {
		out["email"] = p.email
	}
	writeJSON(w, http.StatusOK, out)
}

// credentials is the body of /auth/register and /auth/login. Accounts mode
// sends email plus a client-derived key, never the password itself (see
// internal/auth for why). Single mode sends the shared access token.
type credentials struct {
	Email string `json:"email"`
	KDF   string `json:"kdf"`
	Key   string `json:"key"`
	Token string `json:"token"`
}

// derivedKey validates the key fields of a credentials body. The message is
// shown to users whose app is older than the server, so it says what to do.
func (c credentials) derivedKey() ([]byte, string) {
	if c.KDF != auth.KDF {
		return nil, "this app version derives passwords differently from the server; reload the app"
	}
	key, err := auth.DecodeKey(c.Key)
	if err != nil {
		return nil, err.Error()
	}
	return key, ""
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Mode != ModeAccounts {
		writeErr(w, http.StatusNotFound, "this server has no accounts")
		return
	}
	if !h.cfg.Registration {
		writeErr(w, http.StatusForbidden, "registration is closed")
		return
	}
	var c credentials
	if err := readJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	if !strings.Contains(c.Email, "@") || len(c.Email) > 254 {
		writeErr(w, http.StatusBadRequest, "a valid email address is required")
		return
	}
	key, msg := c.derivedKey()
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	hash, err := auth.HashKey(key)
	if err != nil {
		internal(w, err)
		return
	}
	u, err := h.st.CreateUser(r.Context(), c.Email, hash)
	if errors.Is(err, store.ErrEmailTaken) {
		writeErr(w, http.StatusConflict, "that email is already registered")
		return
	}
	if err != nil {
		internal(w, err)
		return
	}
	if err := h.startSession(w, r, u); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"email": u.Email})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := readJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	switch h.cfg.Mode {
	case ModeAccounts:
		key, msg := c.derivedKey()
		if msg != "" {
			writeErr(w, http.StatusBadRequest, msg)
			return
		}
		u, err := h.st.UserByEmail(r.Context(), strings.ToLower(strings.TrimSpace(c.Email)))
		// Same answer for unknown email and wrong password; the hash check
		// still runs on a dummy so timing does not reveal which it was.
		stored := u.PasswordHash
		if errors.Is(err, sql.ErrNoRows) {
			stored = "sha256$AA$AA"
		} else if err != nil {
			internal(w, err)
			return
		}
		if !auth.CheckKey(key, stored) || err != nil {
			writeErr(w, http.StatusUnauthorized, "email or password incorrect")
			return
		}
		if err := h.startSession(w, r, u); err != nil {
			internal(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"email": u.Email})
	default:
		// Single mode: logging in means presenting the shared token once so
		// the browser can hold it as a cookie instead of a header.
		if h.cfg.AccessToken == "" {
			writeJSON(w, http.StatusOK, map[string]any{"note": "no token required"})
			return
		}
		if !auth.Equal(c.Token, h.cfg.AccessToken) {
			writeErr(w, http.StatusUnauthorized, "access token incorrect")
			return
		}
		h.setCookie(w, c.Token, time.Now().Add(sessionTTL))
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && h.cfg.Mode == ModeAccounts {
		_ = h.st.DeleteSession(r.Context(), auth.Digest(c.Value))
	}
	h.setCookie(w, "", time.Unix(0, 0))
	writeJSON(w, http.StatusOK, map[string]any{})
}

func (h *Handler) startSession(w http.ResponseWriter, r *http.Request, u store.User) error {
	token, digest, err := auth.NewToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(sessionTTL)
	if err := h.st.CreateSession(r.Context(), digest, u, expires); err != nil {
		return err
	}
	h.setCookie(w, token, expires)
	return nil
}

func (h *Handler) setCookie(w http.ResponseWriter, value string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   h.cfg.SecureCookies,
		SameSite: http.SameSiteLaxMode,
	})
}

// ---- tenant endpoints ------------------------------------------------------

func (h *Handler) devices(w http.ResponseWriter, r *http.Request, p principal) {
	ds, err := h.st.Devices(r.Context(), p.tenantID)
	if err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": ds})
}

func (h *Handler) claim(w http.ResponseWriter, r *http.Request, p principal) {
	var d store.Device
	if err := readJSON(r, &d); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	d.NodeID = strings.ToLower(strings.TrimSpace(d.NodeID))
	if !validNodeID(d.NodeID) {
		writeErr(w, http.StatusBadRequest, "nodeId must look like !a1b2c3d4")
		return
	}
	d.Name = clip(d.Name, 64)
	d.ShortName = clip(d.ShortName, 8)
	d.Colour = clip(d.Colour, 16)
	if err := h.st.ClaimDevice(r.Context(), p.tenantID, d); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"claimed": d.NodeID})
}

func (h *Handler) release(w http.ResponseWriter, r *http.Request, p principal) {
	id := strings.ToLower(r.PathValue("nodeId"))
	if !validNodeID(id) {
		writeErr(w, http.StatusBadRequest, "bad node id")
		return
	}
	if err := h.st.ReleaseDevice(r.Context(), p.tenantID, id); err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"released": id})
}

type syncRequest struct {
	Positions []store.Position `json:"positions"`
}

// sync is the phone's outbox upload (docs/DESIGN.md section 6.3). Idempotent
// on (device, ts). In accounts mode only claimed devices are stored: a
// stranger's node heard on the public mesh must not become a record in
// someone's account just because their phone relayed it.
func (h *Handler) sync(w http.ResponseWriter, r *http.Request, p principal) {
	var req syncRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Positions) > maxBatch {
		writeErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("at most %d positions per sync", maxBatch))
		return
	}

	allowed := map[string]bool{}
	if h.cfg.Mode == ModeAccounts {
		ds, err := h.st.Devices(r.Context(), p.tenantID)
		if err != nil {
			internal(w, err)
			return
		}
		for _, d := range ds {
			allowed[d.NodeID] = true
		}
	}

	keep := make([]store.Position, 0, len(req.Positions))
	rejected := map[string]int{}
	invalid := 0
	for _, pos := range req.Positions {
		pos.NodeID = strings.ToLower(pos.NodeID)
		if !pos.Valid() {
			invalid++
			continue
		}
		if h.cfg.Mode == ModeAccounts && !allowed[pos.NodeID] {
			rejected[pos.NodeID]++
			continue
		}
		pos.Provenance = "phone"
		keep = append(keep, pos)
	}

	inserted, duplicates, err := h.st.InsertPositions(r.Context(), p.tenantID, keep)
	if err != nil {
		internal(w, err)
		return
	}
	if h.cfg.RetentionDays > 0 {
		cutoff := time.Now().Add(-time.Duration(h.cfg.RetentionDays) * 24 * time.Hour)
		if _, err := h.st.Purge(r.Context(), p.tenantID, cutoff); err != nil {
			log.Printf("retention purge failed: %v", err)
		}
	}

	unclaimed := make([]string, 0, len(rejected))
	for id := range rejected {
		unclaimed = append(unclaimed, id)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"accepted":   inserted,
		"duplicates": duplicates,
		"invalid":    invalid,
		"unclaimed":  unclaimed,
	})
}

func (h *Handler) positions(w http.ResponseWriter, r *http.Request, p principal) {
	q := r.URL.Query()
	qry := store.Query{
		NodeID: strings.ToLower(q.Get("device")),
		From:   atoi(q.Get("from")),
		To:     atoi(q.Get("to")),
		Limit:  int(atoi(q.Get("limit"))),
	}
	if qry.NodeID != "" && !validNodeID(qry.NodeID) {
		writeErr(w, http.StatusBadRequest, "bad device id")
		return
	}
	ps, err := h.st.Positions(r.Context(), p.tenantID, qry)
	if err != nil {
		internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"positions": ps})
}

// export writes CSV with the PWA's column set, so a file from the server and a
// file from the phone can be analysed by the same tools.
func (h *Handler) export(w http.ResponseWriter, r *http.Request, p principal) {
	if f := r.URL.Query().Get("format"); f != "" && f != "csv" {
		writeErr(w, http.StatusBadRequest, "only format=csv is available")
		return
	}
	ps, err := h.st.Positions(r.Context(), p.tenantID, store.Query{
		NodeID: strings.ToLower(r.URL.Query().Get("device")),
		From:   atoi(r.URL.Query().Get("from")),
		To:     atoi(r.URL.Query().Get("to")),
	})
	if err != nil {
		internal(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="fetchfido-%s.csv"`, time.Now().UTC().Format("20060102T150405Z")))
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"device_id", "timestamp_utc", "lat", "lon", "alt_m", "speed", "heading", "sats",
		"rssi_dbm", "snr_db", "hops", "link", "provenance"})
	// Oldest first, like the phone's export.
	for i := len(ps) - 1; i >= 0; i-- {
		x := ps[i]
		_ = cw.Write([]string{
			x.NodeID, time.Unix(x.TS, 0).UTC().Format(time.RFC3339),
			ftoa(x.Lat), ftoa(x.Lon), optF(x.Alt), optF(x.Speed), optF(x.Heading), optI(x.Sats),
			optI(x.RSSI), optF(x.SNR), optI(x.Hops), x.Link, x.Provenance,
		})
	}
	cw.Flush()
}

// ---- static files ----------------------------------------------------------

// staticHandler serves the embedded PWA with the headers web/_headers gives
// the hosted copy, so both deployments behave the same: no CDN-cached service
// worker that can never update itself, and a hard-cached vendored Leaflet.
func staticHandler(web fs.FS) http.Handler {
	sub, err := fs.Sub(web, "web")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		// Origin only, and only cross-site. OpenStreetMap's tile servers
		// require a Referer and serve an "access blocked" tile without one;
		// no-referrer broke the map on the first hosted deploy. The origin
		// is all they get, never the path. web/_headers says the same for
		// the Worker, which serves these files itself.
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		switch {
		case strings.HasPrefix(r.URL.Path, "/vendor/"):
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		default:
			h.Set("Cache-Control", "no-cache, must-revalidate")
		}
		// The help page is linked as /help, extensionless, because the
		// Worker's asset routing redirects /help.html there and a service
		// worker must never cache a redirect for a navigation. Serve the same
		// path here so the one link works on both deployments.
		if r.URL.Path == "/help" {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/help.html"
			files.ServeHTTP(w, r2)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// ---- helpers ---------------------------------------------------------------

func readJSON(r *http.Request, v any) error {
	ct := r.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		return errors.New("Content-Type must be application/json")
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("bad JSON: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func internal(w http.ResponseWriter, err error) {
	log.Printf("api: %v", err)
	writeErr(w, http.StatusInternalServerError, "internal error")
}

func validNodeID(s string) bool {
	if len(s) != 9 || s[0] != '!' {
		return false
	}
	for _, c := range s[1:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

func atoi(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func optF(p *float64) string {
	if p == nil {
		return ""
	}
	return ftoa(*p)
}

func optI(p *int64) string {
	if p == nil {
		return ""
	}
	return strconv.FormatInt(*p, 10)
}

// Context is unused today but kept so handlers can grow request-scoped data
// without changing signatures.
var _ = context.Background
var _ ctxKey
