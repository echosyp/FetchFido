// Package store is the repository layer: one SQL schema, SQLite dialect, over
// database/sql. Self-host opens it on a local SQLite file (modernc.org/sqlite,
// pure Go, so the scratch container stays static); the hosted version opens it
// on Cloudflare D1, which is SQLite too. Same statements, two drivers.
//
// Tenant isolation lives here and nowhere else (docs/DESIGN.md section 6.4):
// every method takes a tenant ID and every statement filters on it, so a
// handler that forgets a check cannot leak across tenants. Single-tenant
// deployments simply use tenant 1 for everything.
//
// Two D1 constraints shape the code: there are no transactions, so nothing
// here relies on one; and a statement may bind at most 100 parameters, so
// batch inserts are chunked.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// LocalTenant is the one tenant a self-hosted deployment has.
const LocalTenant int64 = 1

// ErrEmailTaken is returned by CreateUser when the address is registered.
var ErrEmailTaken = errors.New("email already registered")

// Executed one statement at a time: D1 runs a single statement per call.
var schema = []string{
	`CREATE TABLE IF NOT EXISTS tenants (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY,
		tenant_id INTEGER NOT NULL REFERENCES tenants(id),
		email TEXT NOT NULL UNIQUE,
		password_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		token_hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id),
		tenant_id INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS devices (
		tenant_id INTEGER NOT NULL,
		node_id TEXT NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		short_name TEXT NOT NULL DEFAULT '',
		colour TEXT NOT NULL DEFAULT '',
		claim_kind TEXT NOT NULL DEFAULT 'node_id',
		claimed_at INTEGER NOT NULL,
		PRIMARY KEY (tenant_id, node_id))`,
	// Append-only facts stamped by the device. The primary key is the dedupe:
	// mesh flooding and phone sync both deliver the same fix more than once.
	`CREATE TABLE IF NOT EXISTS positions (
		tenant_id INTEGER NOT NULL,
		node_id TEXT NOT NULL,
		ts INTEGER NOT NULL,
		lat REAL NOT NULL,
		lon REAL NOT NULL,
		alt REAL,
		speed REAL,
		heading REAL,
		sats INTEGER,
		rssi INTEGER,
		snr REAL,
		hops INTEGER,
		link TEXT NOT NULL DEFAULT 'mesh',
		provenance TEXT NOT NULL DEFAULT 'phone',
		received_at INTEGER NOT NULL,
		PRIMARY KEY (tenant_id, node_id, ts))`,
	`CREATE INDEX IF NOT EXISTS positions_by_time ON positions (tenant_id, ts)`,
}

// Store is the repository. Safe for concurrent use to the extent the driver is.
type Store struct {
	db *sql.DB
}

// New wraps an open database. Call Init before use.
func New(db *sql.DB) *Store { return &Store{db: db} }

// Init creates the schema if absent and guarantees the local tenant exists.
// Idempotent, so every process runs it at startup; no migration tooling.
func (s *Store) Init(ctx context.Context) error {
	for _, stmt := range schema {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, 'local', ?)`,
		LocalTenant, time.Now().Unix())
	return err
}

// ---- users and sessions ----------------------------------------------------

// User is an account. One tenant per account in this version.
type User struct {
	ID           int64
	TenantID     int64
	Email        string
	PasswordHash string
}

// CreateUser registers an account and the tenant that owns its data.
func (s *Store) CreateUser(ctx context.Context, email, passwordHash string) (User, error) {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO tenants (name, created_at) VALUES (?, ?)`, email, now)
	if err != nil {
		return User{}, err
	}
	tenantID, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	res, err = s.db.ExecContext(ctx,
		`INSERT INTO users (tenant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		tenantID, email, passwordHash, now)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			// The orphan tenant row is harmless but untidy; remove it.
			_, _ = s.db.ExecContext(ctx, `DELETE FROM tenants WHERE id = ?`, tenantID)
			return User{}, ErrEmailTaken
		}
		return User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	return User{ID: id, TenantID: tenantID, Email: email, PasswordHash: passwordHash}, nil
}

// UserByEmail returns sql.ErrNoRows when unknown.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, tenant_id, email, password_hash FROM users WHERE email = ?`, email).
		Scan(&u.ID, &u.TenantID, &u.Email, &u.PasswordHash)
	return u, err
}

// CreateSession records a login. tokenHash is a digest; the token itself is
// only ever held by the browser.
func (s *Store) CreateSession(ctx context.Context, tokenHash string, u User, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, u.ID, u.TenantID, time.Now().Unix(), expires.Unix())
	return err
}

// Session resolves a token digest to its user, or sql.ErrNoRows when absent
// or expired.
func (s *Store) Session(ctx context.Context, tokenHash string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT u.id, u.tenant_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = ? AND s.expires_at > ?`, tokenHash, time.Now().Unix()).
		Scan(&u.ID, &u.TenantID, &u.Email)
	return u, err
}

// DeleteSession logs out. Deleting an unknown token is not an error.
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// ---- devices ---------------------------------------------------------------

// Device is a claimed collar.
//
// ClaimKind records how the claim was made. Stock nodes carry no key, so in
// this version it is always "node_id": the claim binds a node ID and nothing
// proves the claimant owns the radio (docs/DESIGN.md section 4). A keyed claim
// will say so here when it exists.
type Device struct {
	NodeID    string `json:"nodeId"`
	Name      string `json:"name"`
	ShortName string `json:"shortName"`
	Colour    string `json:"colour"`
	ClaimKind string `json:"claimKind"`
	ClaimedAt int64  `json:"claimedAt"`
}

// ClaimDevice creates or renames a claim.
func (s *Store) ClaimDevice(ctx context.Context, tenantID int64, d Device) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (tenant_id, node_id, name, short_name, colour, claim_kind, claimed_at)
		 VALUES (?, ?, ?, ?, ?, 'node_id', ?)
		 ON CONFLICT (tenant_id, node_id) DO UPDATE SET
		   name = excluded.name, short_name = excluded.short_name, colour = excluded.colour`,
		tenantID, d.NodeID, d.Name, d.ShortName, d.Colour, time.Now().Unix())
	return err
}

// Devices lists a tenant's claims, by name.
func (s *Store) Devices(ctx context.Context, tenantID int64) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT node_id, name, short_name, colour, claim_kind, claimed_at FROM devices
		 WHERE tenant_id = ? ORDER BY name, node_id`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.NodeID, &d.Name, &d.ShortName, &d.Colour, &d.ClaimKind, &d.ClaimedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ReleaseDevice drops a claim and every position held for it. Deletion is
// real (docs/PRD.md section 9): a dog's track is its owner's movements.
func (s *Store) ReleaseDevice(ctx context.Context, tenantID int64, nodeID string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM positions WHERE tenant_id = ? AND node_id = ?`, tenantID, nodeID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM devices WHERE tenant_id = ? AND node_id = ?`, tenantID, nodeID)
	return err
}

// ---- positions -------------------------------------------------------------

// Position mirrors the PWA's record (web/js/meshtastic.js) plus provenance.
// Pointers are nullable columns; absent telemetry stays absent rather than
// becoming a plausible zero.
type Position struct {
	NodeID     string   `json:"deviceId"`
	TS         int64    `json:"ts"`
	Lat        float64  `json:"lat"`
	Lon        float64  `json:"lon"`
	Alt        *float64 `json:"alt"`
	Speed      *float64 `json:"speed"`
	Heading    *float64 `json:"heading"`
	Sats       *int64   `json:"sats"`
	RSSI       *int64   `json:"rssi"`
	SNR        *float64 `json:"snr"`
	Hops       *int64   `json:"hops"`
	Link       string   `json:"link"`
	Provenance string   `json:"provenance,omitempty"`
}

// Valid rejects coordinates that cannot be real. 0,0 is a node with no fix.
func (p Position) Valid() bool {
	if p.NodeID == "" || p.TS <= 0 {
		return false
	}
	if p.Lat < -90 || p.Lat > 90 || p.Lon < -180 || p.Lon > 180 {
		return false
	}
	return !(p.Lat == 0 && p.Lon == 0)
}

const positionColumns = 15

// InsertPositions stores a batch, skipping any (node, ts) already held.
// Returns how many were new and how many were duplicates. Idempotent, which is
// what lets a phone retry a sync without a bookkeeping protocol.
func (s *Store) InsertPositions(ctx context.Context, tenantID int64, ps []Position) (inserted, duplicates int, err error) {
	now := time.Now().Unix()
	// 100 bound parameters per statement on D1.
	const perStmt = 100 / positionColumns
	for start := 0; start < len(ps); start += perStmt {
		end := min(start+perStmt, len(ps))
		chunk := ps[start:end]

		var b strings.Builder
		b.WriteString(`INSERT OR IGNORE INTO positions
			(tenant_id, node_id, ts, lat, lon, alt, speed, heading, sats, rssi, snr, hops, link, provenance, received_at) VALUES `)
		args := make([]any, 0, len(chunk)*positionColumns)
		for i, p := range chunk {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			link := p.Link
			if link == "" {
				link = "mesh"
			}
			prov := p.Provenance
			if prov == "" {
				prov = "phone"
			}
			args = append(args, tenantID, p.NodeID, p.TS, p.Lat, p.Lon,
				p.Alt, p.Speed, p.Heading, p.Sats, p.RSSI, p.SNR, p.Hops, link, prov, now)
		}
		res, err := s.db.ExecContext(ctx, b.String(), args...)
		if err != nil {
			return inserted, duplicates, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return inserted, duplicates, err
		}
		inserted += int(n)
		duplicates += len(chunk) - int(n)
	}
	return inserted, duplicates, nil
}

// Query selects positions. nodeID "" means every device; from/to are epoch
// seconds, zero for unbounded; limit caps the result, newest first.
type Query struct {
	NodeID string
	From   int64
	To     int64
	Limit  int
}

// Positions returns a tenant's history, newest first.
func (s *Store) Positions(ctx context.Context, tenantID int64, q Query) ([]Position, error) {
	var where []string
	args := []any{tenantID}
	where = append(where, "tenant_id = ?")
	if q.NodeID != "" {
		where = append(where, "node_id = ?")
		args = append(args, q.NodeID)
	}
	if q.From > 0 {
		where = append(where, "ts >= ?")
		args = append(args, q.From)
	}
	if q.To > 0 {
		where = append(where, "ts <= ?")
		args = append(args, q.To)
	}
	limit := q.Limit
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx,
		`SELECT node_id, ts, lat, lon, alt, speed, heading, sats, rssi, snr, hops, link, provenance
		 FROM positions WHERE `+strings.Join(where, " AND ")+` ORDER BY ts DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Position{}
	for rows.Next() {
		var p Position
		if err := rows.Scan(&p.NodeID, &p.TS, &p.Lat, &p.Lon, &p.Alt, &p.Speed, &p.Heading,
			&p.Sats, &p.RSSI, &p.SNR, &p.Hops, &p.Link, &p.Provenance); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Purge applies retention: positions older than the cutoff are deleted.
// Default-short retention is a product requirement, not housekeeping.
func (s *Store) Purge(ctx context.Context, tenantID int64, olderThan time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM positions WHERE tenant_id = ? AND ts < ?`, tenantID, olderThan.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
