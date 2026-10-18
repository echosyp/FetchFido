//go:build js && wasm

// The hosted FetchFido server: the same API compiled to WebAssembly and run
// inside a Cloudflare Worker, with D1 as the database and the PWA served by
// the Worker's static-assets binding (see wrangler.jsonc). Only /api/* reaches
// this code.
//
// The Worker environment, and with it the D1 binding, exists only inside a
// request, so the store is opened per request. That is cheap: the connector
// holds a reference to the binding and makes no connection of its own.
package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"sync"

	"github.com/syumai/workers-go"
	"github.com/syumai/workers-go/cloudflare"
	"github.com/syumai/workers-go/cloudflare/d1"

	"fetchfido/internal/api"
	"fetchfido/internal/store"
)

func env(key, def string) string {
	if v := cloudflare.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	var initOnce sync.Once
	var initErr error

	workers.Serve(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connector, err := d1.OpenConnector(env("D1_BINDING", "DB"))
		if err != nil {
			log.Printf("d1: %v", err)
			http.Error(w, `{"error":"database binding missing"}`, http.StatusInternalServerError)
			return
		}
		st := store.New(sql.OpenDB(connector))

		// Schema creation is idempotent; running it once per isolate keeps
		// the first request after a deploy correct and the rest fast.
		initOnce.Do(func() { initErr = st.Init(context.Background()) })
		if initErr != nil {
			log.Printf("init: %v", initErr)
			http.Error(w, `{"error":"database init failed"}`, http.StatusInternalServerError)
			return
		}

		retention, _ := strconv.Atoi(env("RETENTION_DAYS", "30"))
		iterations, _ := strconv.Atoi(env("PBKDF2_ITERATIONS", "0"))
		api.New(st, api.Config{
			Mode:             api.Mode(env("AUTH_MODE", string(api.ModeAccounts))),
			AccessToken:      env("ACCESS_TOKEN", ""),
			Registration:     env("REGISTRATION", "open") == "open",
			RetentionDays:    retention,
			SecureCookies:    true,
			PBKDF2Iterations: iterations,
		}, nil).ServeHTTP(w, r)
	}))
}
