package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

// Coordinates throughout this file are San Francisco. The real device reports
// from Lubbock, so keeping test data somewhere else means a stray fixture can
// never be mistaken for a real fix.

func TestParseGPSCoordinates(t *testing.T) {
	tests := []struct {
		name     string
		payload  string
		valid    bool
		extended bool
		// Checked only when extended.
		confidence float64
		satellites int
		// nil means the fix should carry no capture time.
		epoch *int64
	}{
		// Both wire formats from PROTOCOL.md. Fields 1-2 are byte-identical
		// between them, which is what lets the device switch without
		// coordinating a deployment.
		{name: "legacy 2-field", payload: "37.774900,-122.419400", valid: true},
		{name: "space separated", payload: "37.774900 -122.419400", valid: true},
		{name: "json form", payload: `{"lat": 37.7749, "lon": -122.4194}`, valid: true},
		{
			name: "extended 5-field", payload: "37.774900,-122.419400,1754160183,2.0,12",
			valid: true, extended: true, confidence: 2.0, satellites: 12,
			epoch: ptr(int64(1754160183)),
		},
		{
			name: "extended space separated", payload: "37.774900 -122.419400 1754160183 1.5 9",
			valid: true, extended: true, confidence: 1.5, satellites: 9,
			epoch: ptr(int64(1754160183)),
		},
		{
			// Epoch 0 means the device had no clock. It must read as unknown,
			// never as 1970-01-01, so the other extended fields survive but the
			// capture time does not.
			name: "extended with epoch 0", payload: "37.774900,-122.419400,0,3.5,8",
			valid: true, extended: true, confidence: 3.5, satellites: 8, epoch: nil,
		},
		{
			// Emitted from an int64_t and not clamped, so it must not be parsed
			// as 32-bit.
			name: "epoch beyond 32 bits", payload: "37.774900,-122.419400,4294967296,2.0,12",
			valid: true, extended: true, confidence: 2.0, satellites: 12,
			epoch: ptr(int64(4294967296)),
		},

		// Rejections listed in PROTOCOL.md.
		{name: "0,0 sentinel", payload: "0,0"},
		{name: "0,0 extended", payload: "0,0,1754160183,2.0,12"},
		{name: "0,0 as json", payload: `{"lat": 0, "lon": 0}`},
		{name: "latitude out of range", payload: "91.0,-122.419400"},
		{name: "longitude out of range", payload: "37.774900,-181.0"},
		{name: "single field", payload: "37.7749"},
		{name: "empty", payload: ""},
		{name: "unparseable epoch", payload: "37.7749,-122.4194,abc,2.0,12"},
		{name: "unparseable confidence", payload: "37.7749,-122.4194,1754160183,xx,12"},
		{name: "unparseable satellites", payload: "37.7749,-122.4194,1754160183,2.0,xx"},

		// The modem's no-lock sentinel. The device filters these, but one
		// arriving must not be stored as a position.
		{name: "no-lock confidence sentinel", payload: "37.7749,-122.4194,1754160183,20000000.0,0"},
		{name: "confidence at the bound", payload: "37.7749,-122.4194,1754160183,1000.0,9"},
		{name: "negative confidence", payload: "37.7749,-122.4194,1754160183,-2.0,9"},
		{
			name: "confidence just under the bound", payload: "37.7749,-122.4194,1754160183,999.9,9",
			valid: true, extended: true, confidence: 999.9, satellites: 9,
			epoch: ptr(int64(1754160183)),
		},

		// The device's own diagnostic strings. Failing these checks is the
		// intended outcome, not something to investigate.
		{name: "WIFI_TEST", payload: "WIFI_TEST:123456"},
		{name: "CELLULAR_TEST", payload: "CELLULAR_TEST:123456"},
		{name: "STARTUP_TEST", payload: "STARTUP_TEST:33.577123,-101.855446"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseGPSCoordinates(tc.payload)

			if got.Valid != tc.valid {
				t.Fatalf("Valid = %v, want %v (payload %q)", got.Valid, tc.valid, tc.payload)
			}
			if !tc.valid {
				return
			}

			if got.Extended != tc.extended {
				t.Errorf("Extended = %v, want %v", got.Extended, tc.extended)
			}
			if !tc.extended {
				return
			}

			if got.Confidence != tc.confidence {
				t.Errorf("Confidence = %v, want %v", got.Confidence, tc.confidence)
			}
			if got.Satellites != tc.satellites {
				t.Errorf("Satellites = %v, want %v", got.Satellites, tc.satellites)
			}

			switch {
			case tc.epoch == nil && got.FixTime != nil:
				t.Errorf("FixTime = %v, want nil (epoch 0 means unknown, not 1970)", got.FixTime)
			case tc.epoch != nil && got.FixTime == nil:
				t.Errorf("FixTime = nil, want epoch %d", *tc.epoch)
			case tc.epoch != nil && got.FixTime.Unix() != *tc.epoch:
				t.Errorf("FixTime.Unix() = %d, want %d", got.FixTime.Unix(), *tc.epoch)
			}
		})
	}
}

// Binary discovery beacons share the listener port, so anything that is not a
// coordinate must be dropped rather than allowed to evict real fixes.
func TestAddMessageRejectsNoise(t *testing.T) {
	ds := NewDataStore(10)

	if got := ds.AddMessage("WIFI_TEST:123456", "test"); got != addUnparseable {
		t.Errorf("noise: got %v, want addUnparseable", got)
	}
	if got := ds.AddMessage("37.774900,-122.419400", "test"); got != addStored {
		t.Errorf("valid fix: got %v, want addStored", got)
	}
	if n := len(ds.GetMessages()); n != 1 {
		t.Errorf("stored %d messages, want 1", n)
	}
}

func TestAddMessageDeduplicates(t *testing.T) {
	ds := NewDataStore(10)
	fix := "37.774900,-122.419400,1754160183,2.0,12"

	if got := ds.AddMessage(fix, "test"); got != addStored {
		t.Fatalf("first delivery: got %v, want addStored", got)
	}
	// A replayed backlog can redeliver a fix that already arrived.
	if got := ds.AddMessage(fix, "test"); got != addDuplicate {
		t.Errorf("replayed delivery: got %v, want addDuplicate", got)
	}
	if n := len(ds.GetMessages()); n != 1 {
		t.Errorf("stored %d, want 1", n)
	}

	// Same position, different capture time, is a genuinely new fix.
	if got := ds.AddMessage("37.774900,-122.419400,1754160200,2.0,12", "test"); got != addStored {
		t.Errorf("later capture at same spot: got %v, want addStored", got)
	}
}

// A stationary device legitimately reports the same position repeatedly. Without
// an epoch there is no key to tell that apart from a redelivery, so those are
// deliberately not deduplicated.
func TestDedupSkipsFixesWithoutCaptureTime(t *testing.T) {
	ds := NewDataStore(10)

	for _, payload := range []string{
		"37.774900,-122.419400",          // legacy, no epoch at all
		"37.774900,-122.419400",          // same spot again
		"37.774900,-122.419400,0,2.0,12", // extended but clockless
		"37.774900,-122.419400,0,2.0,12", // and again
	} {
		if got := ds.AddMessage(payload, "test"); got != addStored {
			t.Errorf("payload %q: got %v, want addStored", payload, got)
		}
	}

	if n := len(ds.GetMessages()); n != 4 {
		t.Errorf("stored %d, want 4 - clockless fixes must not be collapsed", n)
	}
}

func TestRingBufferEviction(t *testing.T) {
	ds := NewDataStore(3)

	for _, epoch := range []int{1, 2, 3, 4, 5} {
		ds.AddMessage(payloadAt(epoch), "test")
	}

	messages := ds.GetMessages()
	if len(messages) != 3 {
		t.Fatalf("stored %d, want 3 (capacity)", len(messages))
	}
	// Oldest evicted, newest retained.
	if got := messages[0].Coordinates.FixTime.Unix(); got != 3 {
		t.Errorf("oldest retained epoch = %d, want 3", got)
	}

	// seq counts everything ever stored, so it keeps rising past capacity -
	// that is what lets a browser detect change once the buffer is full.
	if ds.Seq() != 5 {
		t.Errorf("Seq() = %d, want 5", ds.Seq())
	}
}

// PROTOCOL.md: a live fix is sent before a queued backlog is drained, so arrival
// order is not capture order and a track must be rebuilt from the capture time.
func TestOrderingUsesCaptureTime(t *testing.T) {
	ds := NewDataStore(10)

	ds.AddMessage(payloadAt(500), "test") // captured later, arrives first
	ds.AddMessage(payloadAt(100), "test") // replayed from the backlog

	oldest := ds.GetMessages()
	if got := oldest[0].Coordinates.FixTime.Unix(); got != 100 {
		t.Errorf("GetMessages()[0] epoch = %d, want 100 (oldest first)", got)
	}

	newest := ds.GetMessagesNewestFirst()
	if got := newest[0].Coordinates.FixTime.Unix(); got != 500 {
		t.Errorf("GetMessagesNewestFirst()[0] epoch = %d, want 500", got)
	}
}

// Fixes with no capture time fall back to arrival order, and the sort is stable
// so a legacy-only deployment keeps the order it received things in.
func TestOrderingFallsBackToArrival(t *testing.T) {
	ds := NewDataStore(10)

	for _, lon := range []string{"-122.41", "-122.42", "-122.43"} {
		ds.AddMessage("37.7749,"+lon, "test")
	}

	messages := ds.GetMessages()
	for i, want := range []float64{-122.41, -122.42, -122.43} {
		if messages[i].Coordinates.Longitude != want {
			t.Errorf("position %d = %v, want %v", i, messages[i].Coordinates.Longitude, want)
		}
	}
}

func TestClear(t *testing.T) {
	ds := NewDataStore(10)
	ds.AddMessage("37.774900,-122.419400", "test")
	ds.AddMessage("37.774910,-122.419410", "test")

	before := ds.Seq()
	if got := ds.Clear(); got != 2 {
		t.Errorf("Clear() = %d, want 2", got)
	}
	if n := len(ds.GetMessages()); n != 0 {
		t.Errorf("after Clear stored %d, want 0", n)
	}
	// seq must advance rather than reset, so other browsers watching the event
	// stream notice the change instead of sitting on a list that is gone.
	if ds.Seq() <= before {
		t.Errorf("Seq() = %d, want > %d", ds.Seq(), before)
	}

	if got := ds.Clear(); got != 0 {
		t.Errorf("Clear() on empty store = %d, want 0", got)
	}
}

func TestLimitHelpers(t *testing.T) {
	messages := make([]ReceivedMessage, 5)
	for i := range messages {
		messages[i].Data = string(rune('a' + i))
	}

	// Newest-first slices keep their leading entries...
	if got := limitNewest(messages, 2); len(got) != 2 || got[0].Data != "a" {
		t.Errorf("limitNewest(2) = %v, want first two", got)
	}
	// ...and oldest-first slices keep their trailing ones, because the map
	// draws a track and has to stay chronological.
	if got := limitOldest(messages, 2); len(got) != 2 || got[0].Data != "d" {
		t.Errorf("limitOldest(2) = %v, want last two", got)
	}

	for _, n := range []int{0, -1, 5, 99} {
		if got := limitNewest(messages, n); len(got) != 5 {
			t.Errorf("limitNewest(%d) returned %d, want all 5", n, len(got))
		}
		if got := limitOldest(messages, n); len(got) != 5 {
			t.Errorf("limitOldest(%d) returned %d, want all 5", n, len(got))
		}
	}
}

func TestParseLimit(t *testing.T) {
	tests := []struct {
		query string
		want  int
	}{
		{query: "", want: 250},         // absent takes the default
		{query: "?limit=all", want: 0}, // explicit opt-out
		{query: "?limit=25", want: 25},
		{query: "?limit=0", want: 0},
		{query: "?limit=-5", want: 0},
		{query: "?limit=abc", want: 0},
	}

	for _, tc := range tests {
		r := httptest.NewRequest("GET", "/"+tc.query, nil)
		if got := parseLimit(r); got != tc.want {
			t.Errorf("parseLimit(%q) = %d, want %d", tc.query, got, tc.want)
		}
	}
}

// The selector must never sit on "All" while the page renders a truncated list,
// so a hand-typed limit that is not one of the round sizes gets folded in.
func TestLimitChoicesIncludeCurrent(t *testing.T) {
	choices := limitChoices(500, 4)

	if len(choices) == 0 || choices[0] != 4 {
		t.Errorf("limitChoices(500, 4) = %v, want 4 folded in and sorted first", choices)
	}

	// Sizes at or above capacity are indistinguishable from "All".
	for _, c := range limitChoices(50, 0) {
		if c >= 50 {
			t.Errorf("limitChoices(50, 0) offered %d, which is >= capacity", c)
		}
	}
}

func TestSummarizeDropped(t *testing.T) {
	// Printable payloads are quoted so a malformed fix can be read.
	if got := summarizeDropped([]byte("STARTUP_TEST:123456")); got != `"STARTUP_TEST:123456"` {
		t.Errorf("printable: got %s", got)
	}

	// The real LAN beacon that shares this port. Writing its control bytes to a
	// terminal is what the size-only log was avoiding.
	beacon := []byte{0xd0, 0xf2, 0x81, 0xf8}
	if got := summarizeDropped(beacon); got != "hex:d0f281f8" {
		t.Errorf("binary: got %s, want hex form", got)
	}

	long := make([]byte, 200)
	for i := range long {
		long[i] = 'A'
	}
	if got := summarizeDropped(long); len(got) > 100 {
		t.Errorf("oversized payload rendered %d chars, want it capped", len(got))
	}
}

func TestFixTimeLocalMatchesDisplayZone(t *testing.T) {
	original := displayLoc
	defer func() { displayLoc = original }()

	loc, err := time.LoadLocation("America/Chicago")
	if err != nil {
		t.Skipf("zoneinfo unavailable: %v", err)
	}
	displayLoc = loc

	fixTime := time.Unix(1754160183, 0).UTC()
	msg := ReceivedMessage{
		Timestamp:   fixTime,
		Coordinates: GPSCoordinate{FixTime: &fixTime},
	}

	// Arrival and capture are the same instant here, so any difference in the
	// rendered strings means the two are being formatted in different zones -
	// the bug where a fix taken a second earlier read as hours earlier.
	if msg.LocalTime() != msg.FixTimeLocal() {
		t.Errorf("LocalTime() = %q but FixTimeLocal() = %q", msg.LocalTime(), msg.FixTimeLocal())
	}

	// No capture time renders empty, so the template can say "unknown" rather
	// than print a date the device never reported.
	if (ReceivedMessage{}).FixTimeLocal() != "" {
		t.Error("FixTimeLocal() on a clockless fix should be empty")
	}
}

func ptr[T any](v T) *T { return &v }

// payloadAt builds an extended fix whose capture time is the given epoch, at a
// position derived from it so distinct epochs are distinct positions.
func payloadAt(epoch int) string {
	return "37.7749,-122.4194," + itoa(epoch) + ",2.0,12"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
