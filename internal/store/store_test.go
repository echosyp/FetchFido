package store_test

import (
	"database/sql"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"fetchfido/internal/store"
)

func open(t *testing.T) *store.Store {
	t.Helper()
	db, err := sql.Open("sqlite", "file::memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	st := store.New(db)
	if err := st.Init(t.Context()); err != nil {
		t.Fatal(err)
	}
	// Init twice: it must be idempotent, every process runs it at startup.
	if err := st.Init(t.Context()); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestBatchInsertChunksAndCounts(t *testing.T) {
	st := open(t)
	ctx := t.Context()
	// More rows than fit in one statement under the 100-parameter cap.
	var ps []store.Position
	for i := 0; i < 50; i++ {
		ps = append(ps, store.Position{NodeID: "!9ea0eaac", TS: int64(1000 + i), Lat: 37.77, Lon: -122.41})
	}
	ins, dup, err := st.InsertPositions(ctx, store.LocalTenant, ps)
	if err != nil || ins != 50 || dup != 0 {
		t.Fatalf("first insert: %d %d %v", ins, dup, err)
	}
	ins, dup, err = st.InsertPositions(ctx, store.LocalTenant, ps[:20])
	if err != nil || ins != 0 || dup != 20 {
		t.Fatalf("re-insert: %d %d %v", ins, dup, err)
	}
	got, err := st.Positions(ctx, store.LocalTenant, store.Query{From: 1040, Limit: 5})
	if err != nil || len(got) != 5 || got[0].TS != 1049 {
		t.Fatalf("query: %v %v", got, err)
	}
	n, err := st.Purge(ctx, store.LocalTenant, time.Unix(1010, 0))
	if err != nil || n != 10 {
		t.Fatalf("purge: %d %v", n, err)
	}
}

func TestTenantsDoNotSeeEachOther(t *testing.T) {
	st := open(t)
	ctx := t.Context()
	a, err := st.CreateUser(ctx, "a@x", "h")
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.CreateUser(ctx, "b@x", "h")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateUser(ctx, "a@x", "h"); err != store.ErrEmailTaken {
		t.Fatalf("duplicate email: %v", err)
	}
	if a.TenantID == b.TenantID || a.TenantID == store.LocalTenant {
		t.Fatalf("tenants: %d %d", a.TenantID, b.TenantID)
	}
	_, _, _ = st.InsertPositions(ctx, a.TenantID, []store.Position{{NodeID: "!1", TS: 1, Lat: 1, Lon: 1}})
	got, _ := st.Positions(ctx, b.TenantID, store.Query{})
	if len(got) != 0 {
		t.Fatal("leak across tenants")
	}
	if err := st.ClaimDevice(ctx, a.TenantID, store.Device{NodeID: "!1", Name: "Fido"}); err != nil {
		t.Fatal(err)
	}
	ds, _ := st.Devices(ctx, b.TenantID)
	if len(ds) != 0 {
		t.Fatal("device leak across tenants")
	}
}

func TestSessions(t *testing.T) {
	st := open(t)
	ctx := t.Context()
	u, _ := st.CreateUser(ctx, "a@x", "h")
	if err := st.CreateSession(ctx, "digest", u, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	got, err := st.Session(ctx, "digest")
	if err != nil || got.TenantID != u.TenantID || got.Email != "a@x" {
		t.Fatalf("session: %v %v", got, err)
	}
	if err := st.CreateSession(ctx, "old", u, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Session(ctx, "old"); err != sql.ErrNoRows {
		t.Fatalf("expired session: %v", err)
	}
	_ = st.DeleteSession(ctx, "digest")
	if _, err := st.Session(ctx, "digest"); err != sql.ErrNoRows {
		t.Fatalf("deleted session: %v", err)
	}
}
