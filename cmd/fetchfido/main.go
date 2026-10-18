// The self-hosted FetchFido server: one static binary serving the PWA and the
// API, with SQLite on a local file. Runs in a scratch container as a non-root
// user, exactly like the earlier prototype on the main branch.
//
// Configuration is by environment variable, because that is what containers
// and k8s manifests speak. Each one is reported at startup so a forgotten
// setting is visible in the log rather than discovered in the field.
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	_ "modernc.org/sqlite"

	fetchfido "fetchfido"
	"fetchfido/internal/api"
	"fetchfido/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	listen := env("LISTEN", ":8080")
	dbPath := env("DB_PATH", "/data/fetchfido.db")
	mode := api.Mode(env("AUTH_MODE", string(api.ModeSingle)))
	accessToken := env("ACCESS_TOKEN", "")
	registration := env("REGISTRATION", "open") == "open"
	retention, _ := strconv.Atoi(env("RETENTION_DAYS", "30"))
	iterations, _ := strconv.Atoi(env("PBKDF2_ITERATIONS", "0"))
	certFile := env("TLS_CERT_FILE", "")
	keyFile := env("TLS_KEY_FILE", "")
	tls := certFile != "" && keyFile != ""

	if mode != api.ModeSingle && mode != api.ModeAccounts {
		log.Fatalf("AUTH_MODE must be %q or %q, got %q", api.ModeSingle, api.ModeAccounts, mode)
	}

	// WAL for concurrent readers; a busy timeout so a second writer waits
	// instead of failing; temp tables in memory because scratch has no /tmp.
	dsn := "file:" + dbPath + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=temp_store(MEMORY)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	// SQLite is single-writer; one connection avoids lock contention outright.
	db.SetMaxOpenConns(1)
	st := store.New(db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := st.Init(ctx); err != nil {
		log.Fatalf("init database at %s: %v", dbPath, err)
	}
	cancel()

	h := api.New(st, api.Config{
		Mode:             mode,
		AccessToken:      accessToken,
		Registration:     registration,
		RetentionDays:    retention,
		SecureCookies:    tls || env("SECURE_COOKIES", "") == "true",
		PBKDF2Iterations: iterations,
	}, fetchfido.Web)

	log.Printf("FetchFido server starting")
	log.Printf("Database: %s", dbPath)
	log.Printf("Mode: %s", mode)
	switch {
	case mode == api.ModeAccounts:
		log.Printf("Accounts: registration %s", map[bool]string{true: "open", false: "closed"}[registration])
	case accessToken != "":
		log.Printf("Access token: required")
	default:
		log.Printf("Warning: no access token. Anyone who can reach this port can read and write positions. Set ACCESS_TOKEN if that is not a trusted network.")
	}
	if retention > 0 {
		log.Printf("Retaining positions for %d days", retention)
	} else {
		log.Printf("Warning: RETENTION_DAYS=0 keeps positions forever")
	}

	srv := &http.Server{
		Addr:              listen,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if tls {
		log.Printf("HTTPS server: https://%s", listen)
		log.Fatal(srv.ListenAndServeTLS(certFile, keyFile))
	}
	log.Printf("HTTP server: http://%s (no TLS; put it behind a proxy or set TLS_CERT_FILE/TLS_KEY_FILE)", listen)
	log.Fatal(srv.ListenAndServe())
}
