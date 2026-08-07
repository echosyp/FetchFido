package main

import (
	"crypto/subtle"
	"crypto/tls"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	htmltemplate "html/template"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	texttemplate "text/template"
	"time"

	// The runtime image is FROM scratch, so there is no /usr/share/zoneinfo.
	// This embeds the database in the binary (~450 KB) so DISPLAY_TZ works.
	_ "time/tzdata"
)

type HealthResponse struct {
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
	Version   string    `json:"version"`
}

type InfoResponse struct {
	Service     string `json:"service"`
	Version     string `json:"version"`
	Environment string `json:"environment"`
}

// maxPlausibleConfidence bounds a real horizontal-error reading in metres. The
// device only transmits fixes at or below its configured threshold (default 30,
// adjustable at runtime), so this leaves generous headroom for a loosened
// threshold. It also rejects the modem's no-lock sentinel of 20000000.0, which
// PROTOCOL.md says the device already filters but which must be discarded rather
// than stored as a position if one ever arrives.
const maxPlausibleConfidence = 1000.0

type GPSCoordinate struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Valid     bool    `json:"valid"`

	// Extended reports whether the 5-field payload was received. The remaining
	// fields below are only populated when it is true.
	Extended bool `json:"extended"`

	// FixTime is when the fix was taken, which is not when the datagram was
	// sent: the device replays buffered fixes. It is nil when the device had no
	// clock (epoch 0 on the wire) — that means "unknown", never 1970-01-01.
	FixTime *time.Time `json:"fix_time,omitempty"`

	// Confidence is the modem's estimated horizontal error in metres, lower
	// being better. PROTOCOL.md warns it reads optimistically in poor
	// conditions, so it is not a radius that can be drawn.
	Confidence float64 `json:"confidence,omitempty"`

	// Satellites is the total number seen, not the number with a usable
	// signal, so a high count does not imply a good fix.
	Satellites int `json:"satellites,omitempty"`
}

// displayLoc is the zone timestamps are rendered in. UTC by default, which is
// correct but reads as six hours wrong to someone in Central time who is not
// expecting it - so the rendered form always names the zone.
var displayLoc = time.UTC

func initDisplayTZ() {
	name := getEnv("DISPLAY_TZ", "UTC")

	loc, err := time.LoadLocation(name)
	if err != nil {
		log.Printf("Unknown DISPLAY_TZ %q, falling back to UTC: %v", name, err)
		return
	}

	displayLoc = loc
	log.Printf("Timestamps displayed in %s", name)
}

// Rendered wherever a timestamp is shown. The zone abbreviation is not
// decoration: without it a reader has no way to know whether 02:12:40 is their
// local time or UTC, and both are plausible.
func formatTS(t time.Time) string {
	return t.In(displayLoc).Format("2006-01-02 15:04:05 MST")
}

type ReceivedMessage struct {
	Timestamp   time.Time     `json:"timestamp"`
	Data        string        `json:"data"`
	Source      string        `json:"source"`
	Coordinates GPSCoordinate `json:"coordinates"`
}

// LocalTime is what the templates call, so the zone is applied in one place
// rather than repeated as a format string at every call site.
func (m ReceivedMessage) LocalTime() string {
	return formatTS(m.Timestamp)
}

// FixTimeLocal renders the capture time in the same zone as LocalTime. Without
// this the templates showed arrival in the display zone and capture in UTC, so a
// fix taken one second before it arrived read as hours earlier on the same card.
// Empty when the device had no clock, which the templates render as unknown.
func (m ReceivedMessage) FixTimeLocal() string {
	if m.Coordinates.FixTime == nil {
		return ""
	}
	return formatTS(*m.Coordinates.FixTime)
}

// EffectiveTime is the time a message should be ordered by: the capture time
// when the device reported one, and arrival time otherwise. PROTOCOL.md is
// explicit that a track must be reconstructed from the capture time, because a
// live fix is sent before a queued backlog is drained and UDP does not preserve
// order either.
func (m ReceivedMessage) EffectiveTime() time.Time {
	if m.Coordinates.FixTime != nil {
		return *m.Coordinates.FixTime
	}
	return m.Timestamp
}

type DataStore struct {
	mu       sync.RWMutex
	messages []ReceivedMessage
	maxSize  int

	// seq counts every message ever stored. Unlike the message count it keeps
	// rising once the ring buffer is full, so a browser can tell whether
	// anything landed since its page was rendered.
	seq uint64

	// subs are woken whenever a message is stored. Each channel is a bare
	// signal; readers re-read seq for themselves, so a dropped wakeup on a
	// full channel cannot leave a client looking at a stale value.
	subs map[chan struct{}]struct{}
}

func NewDataStore(maxSize int) *DataStore {
	return &DataStore{
		messages: make([]ReceivedMessage, 0),
		maxSize:  maxSize,
		subs:     make(map[chan struct{}]struct{}),
	}
}

// Subscribe returns a channel signalled on every stored message. The caller
// must Unsubscribe when finished.
func (ds *DataStore) Subscribe() chan struct{} {
	ch := make(chan struct{}, 1)
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.subs[ch] = struct{}{}
	return ch
}

func (ds *DataStore) Unsubscribe(ch chan struct{}) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	delete(ds.subs, ch)
}

// Seq reports how many messages have been stored over the process's lifetime.
func (ds *DataStore) Seq() uint64 {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.seq
}

// validLatLon applies PROTOCOL.md's rejection rules. 0,0 is a no-lock sentinel
// that should already have been filtered device-side, not a position in the Gulf
// of Guinea.
func validLatLon(lat, lon float64) bool {
	if lat == 0 && lon == 0 {
		return false
	}
	return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

// parseGPSCoordinates accepts both tracker payload lengths described in
// PROTOCOL.md:
//
//	33.551746,-101.902097                        (2 fields)
//	33.551746,-101.902097,1754160183,2.0,12      (5 fields: +epoch, conf, sats)
//
// The first two fields are byte-identical in both, so the device can be switched
// to the extended payload — and back — without coordinating a deployment.
// Anything else, including the WIFI_TEST/CELLULAR_TEST/STARTUP_TEST diagnostic
// strings, fails these checks, which is the intended outcome.
func parseGPSCoordinates(data string) GPSCoordinate {
	coords := GPSCoordinate{Valid: false}

	data = strings.TrimSpace(data)

	// Try JSON format first: {"lat": 40.7128, "lon": -74.0060}
	if strings.HasPrefix(data, "{") {
		var jsonCoords struct {
			Lat float64 `json:"lat"`
			Lon float64 `json:"lon"`
		}
		if err := json.Unmarshal([]byte(data), &jsonCoords); err == nil {
			if !validLatLon(jsonCoords.Lat, jsonCoords.Lon) {
				return coords
			}
			coords.Latitude = jsonCoords.Lat
			coords.Longitude = jsonCoords.Lon
			coords.Valid = true
			return coords
		}
	}

	// Try comma or space separated format: "40.7128,-74.0060" or "40.7128 -74.0060"
	parts := strings.FieldsFunc(data, func(c rune) bool {
		return c == ',' || c == ' '
	})

	if len(parts) < 2 {
		return coords
	}

	lat, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return coords
	}
	lon, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return coords
	}
	if !validLatLon(lat, lon) {
		return coords
	}

	coords.Latitude = lat
	coords.Longitude = lon
	coords.Valid = true

	// Fewer than 5 fields is the legacy payload: position only, nothing else to
	// read. A 3- or 4-field datagram is not a format the device emits, so treat
	// it the same way rather than guessing at partial extended data.
	if len(parts) < 5 {
		return coords
	}

	// Parsed as 64-bit: PROTOCOL.md notes the epoch comes from an int64_t and is
	// not clamped to 32 bits.
	epoch, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return GPSCoordinate{Valid: false}
	}
	confidence, err := strconv.ParseFloat(parts[3], 64)
	if err != nil {
		return GPSCoordinate{Valid: false}
	}
	satellites, err := strconv.Atoi(parts[4])
	if err != nil {
		return GPSCoordinate{Valid: false}
	}

	// An implausible confidence means the position is not a measurement, so the
	// whole datagram is dropped rather than stored with the field blanked out.
	// A negative error distance is meaningless and is treated the same way.
	if confidence < 0 || confidence >= maxPlausibleConfidence {
		return GPSCoordinate{Valid: false}
	}

	coords.Extended = true
	coords.Confidence = confidence
	coords.Satellites = satellites

	// Epoch 0 means the device had no clock when it took the fix. Leaving
	// FixTime nil keeps that distinct from a real timestamp.
	if epoch != 0 {
		fixTime := time.Unix(epoch, 0).UTC()
		coords.FixTime = &fixTime
	}

	return coords
}

// addResult distinguishes the two reasons a datagram is not stored. They need
// different handling: unparseable traffic is noise, whereas a duplicate was
// genuinely delivered and its sender should be told so rather than left
// retrying.
type addResult int

const (
	addStored addResult = iota
	addUnparseable
	addDuplicate
)

// AddMessage stores data only if it parses as GPS coordinates and is not
// already held. Unparseable traffic is dropped so that broadcast noise on a
// shared network cannot evict real coordinates from the buffer.
func (ds *DataStore) AddMessage(data, source string) addResult {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	coordinates := parseGPSCoordinates(data)
	if !coordinates.Valid {
		return addUnparseable
	}

	if ds.isDuplicate(coordinates) {
		return addDuplicate
	}

	msg := ReceivedMessage{
		Timestamp:   time.Now(),
		Data:        data,
		Source:      source,
		Coordinates: coordinates,
	}

	ds.messages = append(ds.messages, msg)

	if len(ds.messages) > ds.maxSize {
		ds.messages = ds.messages[1:]
	}

	ds.seq++

	// Non-blocking, so a browser that has stopped reading cannot stall the UDP
	// listener. A missed wakeup is harmless: the channel already holds one.
	for ch := range ds.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}

	return addStored
}

// isDuplicate reports whether an identical fix is already stored, keyed on
// (epoch, lat, lon) as PROTOCOL.md recommends. Nothing suppresses duplicates on
// the wire, and a replayed backlog can redeliver a fix that already arrived.
//
// Only fixes carrying a capture time are deduplicated. Epoch 0 makes the key
// useless - every clockless fix would share it - and a legacy 2-field payload
// has no epoch at all, so a device parked in one spot would have its genuinely
// repeated positions collapsed into one. Those are left alone deliberately.
//
// The caller already holds the lock.
func (ds *DataStore) isDuplicate(c GPSCoordinate) bool {
	if c.FixTime == nil {
		return false
	}

	for _, existing := range ds.messages {
		if existing.Coordinates.FixTime == nil {
			continue
		}
		if existing.Coordinates.FixTime.Equal(*c.FixTime) &&
			existing.Coordinates.Latitude == c.Latitude &&
			existing.Coordinates.Longitude == c.Longitude {
			return true
		}
	}

	return false
}

// Clear discards every stored message. The store is memory-only, so this is
// irreversible - CSV export is the only way to keep the data. seq still advances
// rather than resetting, so other browsers watching the event stream notice the
// change and refresh instead of sitting on a list that no longer exists.
func (ds *DataStore) Clear() int {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	discarded := len(ds.messages)
	if discarded == 0 {
		return 0
	}

	ds.messages = ds.messages[:0]
	ds.seq++

	for ch := range ds.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}

	return discarded
}

// MaxSize reports the ring-buffer capacity, so the UI can offer display sizes
// that make sense against it.
func (ds *DataStore) MaxSize() int {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	return ds.maxSize
}

// GetMessages returns the stored messages oldest first, ordered by capture time
// where the device supplied one. Replayed fixes arrive out of order, so this is
// not the same as the order they were received in. The sort is stable, which
// leaves messages without a capture time — every 2-field payload — in arrival
// order relative to each other.
func (ds *DataStore) GetMessages() []ReceivedMessage {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	result := make([]ReceivedMessage, len(ds.messages))
	copy(result, ds.messages)

	sort.SliceStable(result, func(i, j int) bool {
		return result[i].EffectiveTime().Before(result[j].EffectiveTime())
	})

	return result
}

// GetMessagesNewestFirst returns the same messages with the most recent first,
// for display.
func (ds *DataStore) GetMessagesNewestFirst() []ReceivedMessage {
	messages := ds.GetMessages()

	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	return messages
}

var dataStore *DataStore

// parseLimit reads the ?limit= display cap. An absent parameter takes the
// configured default rather than showing everything: with a large MAX_MESSAGES a
// full buffer would otherwise render thousands of message rows, map markers and
// polyline points on every load. "all" opts out explicitly. The limit only
// affects what is rendered - nothing is evicted, so widening it again brings the
// older fixes straight back.
func parseLimit(r *http.Request) int {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultLimit()
	}
	if raw == "all" {
		return 0
	}

	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0
	}

	return n
}

// defaultLimit is how many fixes are shown when the URL says nothing. 0 means
// no cap, which is only sensible for a small buffer.
func defaultLimit() int {
	const fallback = 250

	raw := getEnv("DEFAULT_LIMIT", "")
	if raw == "" {
		return fallback
	}

	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		log.Printf("Invalid DEFAULT_LIMIT %q, using %d", raw, fallback)
		return fallback
	}

	return n
}

// limitNewest trims a newest-first slice to its leading n entries.
func limitNewest(messages []ReceivedMessage, n int) []ReceivedMessage {
	if n <= 0 || n >= len(messages) {
		return messages
	}
	return messages[:n]
}

// limitOldest trims an oldest-first slice to its trailing n entries, which are
// the most recent ones. The map keeps chronological order because its polyline
// is a track, so the newest entries have to be taken from the end.
func limitOldest(messages []ReceivedMessage, n int) []ReceivedMessage {
	if n <= 0 || n >= len(messages) {
		return messages
	}
	return messages[len(messages)-n:]
}

// limitChoices offers round display sizes below the buffer capacity. Anything at
// or above capacity would be indistinguishable from "All", so it is left out.
//
// A current limit that is not one of the round numbers - typed straight into the
// URL - is folded in. Without that the selector would sit on "All" while the
// page rendered a truncated list, which is worse than offering an odd number.
func limitChoices(maxSize, current int) []int {
	candidates := []int{10, 25, 50, 100, 250, 500, 1000, 2500, 5000}

	choices := make([]int, 0, len(candidates)+1)
	for _, c := range candidates {
		if c < maxSize {
			choices = append(choices, c)
		}
	}

	if current > 0 {
		present := false
		for _, c := range choices {
			if c == current {
				present = true
				break
			}
		}
		if !present {
			choices = append(choices, current)
			sort.Ints(choices)
		}
	}

	return choices
}

// maxMessages reads the ring-buffer capacity from the environment. It bounds
// memory directly: every accepted fix is retained until evicted.
func maxMessages() int {
	const fallback = 100

	raw := getEnv("MAX_MESSAGES", "")
	if raw == "" {
		return fallback
	}

	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		log.Printf("Invalid MAX_MESSAGES %q, using %d", raw, fallback)
		return fallback
	}

	return n
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	response := HealthResponse{
		Status:    "healthy",
		Timestamp: time.Now(),
		Version:   getEnv("APP_VERSION", "1.0.0"),
	}

	json.NewEncoder(w).Encode(response)
}

func infoHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	response := InfoResponse{
		Service:     "FetchFido",
		Version:     getEnv("APP_VERSION", "1.0.0"),
		Environment: getEnv("APP_ENV", "development"),
	}

	json.NewEncoder(w).Encode(response)
}

var htmlTemplates *htmltemplate.Template
var jsTemplates *texttemplate.Template

func rootHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")

	stored := dataStore.GetMessagesNewestFirst()
	limit := parseLimit(r)
	messages := limitNewest(stored, limit)

	data := struct {
		Messages     []ReceivedMessage
		MessageCount int
		StoredCount  int
		Limit        int
		LimitChoices []int
		MaxSize      int
		ListenPort   string
		WebPort      string
	}{
		Messages:     messages,
		MessageCount: len(messages),
		StoredCount:  len(stored),
		Limit:        limit,
		LimitChoices: limitChoices(dataStore.MaxSize(), limit),
		MaxSize:      dataStore.MaxSize(),
		ListenPort:   getEnv("LISTEN_PORT", "9998"),
		WebPort:      getEnv("PORT", "8080"),
	}

	err := htmlTemplates.ExecuteTemplate(w, "index.html", data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func messagesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	messages := limitNewest(dataStore.GetMessagesNewestFirst(), parseLimit(r))
	json.NewEncoder(w).Encode(messages)
}

// clearHandler discards every stored message. POST only: a GET would let a
// crawler, a prefetch or a stray link destroy the buffer, and the store is
// memory-only so there is nothing to recover it from.
func clearHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	discarded := dataStore.Clear()
	log.Printf("Cleared %d stored message(s) on request from %s", discarded, r.RemoteAddr)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"cleared": discarded})
}

// eventsHandler streams a server-sent event whenever a message is stored, so the
// page refreshes when coordinates actually arrive instead of on a timer.
func eventsHandler(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Stops a reverse proxy buffering the stream into uselessness.
	w.Header().Set("X-Accel-Buffering", "no")

	notify := dataStore.Subscribe()
	defer dataStore.Unsubscribe(notify)

	// Send the current sequence straight away. A datagram can land between the
	// page rendering and this stream opening, and the client compares what it
	// receives against what it rendered, so that gap closes itself.
	sendSeq := func() {
		fmt.Fprintf(w, "event: seq\ndata: %d\n\n", dataStore.Seq())
		flusher.Flush()
	}
	sendSeq()

	// Idle connections are otherwise liable to be reaped by anything in between.
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-notify:
			sendSeq()
		case <-keepalive.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func gpsDataHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")

	// Oldest first: this feeds the map, where the polyline is a track and has to
	// be drawn in the order the positions were captured. The display limit keeps
	// the newest n, so the map and the message list show the same fixes.
	messages := limitOldest(dataStore.GetMessages(), parseLimit(r))

	data := struct {
		Messages     []ReceivedMessage
		MessageCount int
		ListenPort   string
		WebPort      string
		Seq          uint64
	}{
		Messages:     messages,
		MessageCount: len(messages),
		ListenPort:   getEnv("LISTEN_PORT", "9998"),
		WebPort:      getEnv("PORT", "8080"),
		Seq:          dataStore.Seq(),
	}

	err := jsTemplates.ExecuteTemplate(w, "gps-data.js", data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func exportCSVHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=fetchfido_export.csv")

	messages := dataStore.GetMessages()

	writer := csv.NewWriter(w)
	defer writer.Flush()

	// Write CSV header
	err := writer.Write([]string{
		"Timestamp", "Source", "Data", "Latitude", "Longitude", "GPS Valid",
		// Not labelled UTC: these render in DISPLAY_TZ like every other
		// timestamp, and formatTS names the zone in the value itself.
		"Fix Time", "Confidence (m)", "Satellites",
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Write data rows
	for _, msg := range messages {
		lat := ""
		lon := ""
		valid := "false"

		if msg.Coordinates.Valid {
			lat = strconv.FormatFloat(msg.Coordinates.Latitude, 'f', -1, 64)
			lon = strconv.FormatFloat(msg.Coordinates.Longitude, 'f', -1, 64)
			valid = "true"
		}

		// Left empty on a legacy payload, and on an extended one whose device
		// had no clock. An empty cell reads as unknown; 1970-01-01 would not.
		fixTime := ""
		confidence := ""
		satellites := ""

		if msg.Coordinates.FixTime != nil {
			fixTime = formatTS(*msg.Coordinates.FixTime)
		}
		if msg.Coordinates.Extended {
			confidence = strconv.FormatFloat(msg.Coordinates.Confidence, 'f', -1, 64)
			satellites = strconv.Itoa(msg.Coordinates.Satellites)
		}

		err := writer.Write([]string{
			formatTS(msg.Timestamp),
			msg.Source,
			msg.Data,
			lat,
			lon,
			valid,
			fixTime,
			confidence,
			satellites,
		})
		if err != nil {
			log.Printf("Error writing CSV row: %v", err)
		}
	}
}

func udpListener() {
	// 0.0.0.0, not loopback. Binding 127.0.0.1 inside a container works only
	// because rootless podman happens to proxy forwarded traffic to loopback;
	// under rootful podman, a bridge network or Kubernetes the listener would
	// come up cleanly, serve the dashboard, and silently receive nothing.
	listenIP := getEnv("LISTEN_IP", "0.0.0.0")
	listenPort := getEnv("LISTEN_PORT", "9998")

	// Acknowledge accepted datagrams so the sender can tell delivery from
	// "the datagram left the building". UDP reports success as soon as the
	// packet is handed to the stack, which is why a wrong port, a dead server
	// or a broken NAT loopback all look identical from the device.
	//
	// Off unless enabled, so a tracker configured to require ACKs is never
	// surprised by a server that predates them.
	ackEnabled := getEnv("ACK_ENABLED", "false") == "true"
	addr, err := net.ResolveUDPAddr("udp", listenIP+":"+listenPort)
	if err != nil {
		log.Fatal("Error resolving UDP address:", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatal("Error starting UDP listener:", err)
	}
	defer conn.Close()

	log.Printf("UDP listener started on %s:%s (ack=%v)", listenIP, listenPort, ackEnabled)

	buffer := make([]byte, 1024)
	for {
		n, clientAddr, err := conn.ReadFromUDP(buffer)
		if err != nil {
			log.Printf("Error reading UDP message: %v", err)
			continue
		}

		message := string(buffer[:n])
		source := clientAddr.String()

		switch dataStore.AddMessage(message, source) {
		case addUnparseable:
			log.Printf("Ignored non-GPS message from %s (%d bytes): %s",
				source, n, summarizeDropped(buffer[:n]))
			continue

		case addDuplicate:
			// Acknowledged below despite not being stored. The fix did arrive -
			// twice - and withholding the ACK would have the sender retry a
			// position already held, forever.
			log.Printf("Duplicate fix from %s, already stored: %s", source, message)

		case addStored:
			log.Printf("Received UDP message from %s: %s", source, message)
		}

		// A sender treating silence as failure will retry anything not
		// acknowledged, which is the behaviour worth having: it is stored (or
		// already was) or it is retried, never silently dropped.
		if ackEnabled {
			if _, err := conn.WriteToUDP([]byte("ACK"), clientAddr); err != nil {
				log.Printf("Failed to ACK %s: %v", source, err)
			}
		}
	}
}

// summarizeDropped renders a dropped datagram for the log. Printable payloads
// are quoted so a malformed fix can actually be read; anything else is shown as
// hex, because this port also carries binary discovery beacons and writing
// their control bytes straight to the terminal is what logging the size alone
// was avoiding. Both forms are capped so one large datagram cannot flood the log.
func summarizeDropped(payload []byte) string {
	const maxLogged = 64

	truncated := len(payload) > maxLogged
	if truncated {
		payload = payload[:maxLogged]
	}

	printable := true
	for _, c := range payload {
		if c < 0x20 || c > 0x7e {
			printable = false
			break
		}
	}

	var rendered string
	if printable {
		rendered = strconv.Quote(string(payload))
	} else {
		rendered = "hex:" + hex.EncodeToString(payload)
	}

	if truncated {
		rendered += " (truncated)"
	}

	return rendered
}

// requireAuth wraps a handler in HTTP basic auth when AUTH_USER and AUTH_PASS
// are both set. With either unset it is a no-op, so an existing deployment is
// never locked out by upgrading - but the dashboard serves live positions and
// /clear destroys the only copy of them, so setting these is worth doing on any
// network you do not fully control.
//
// Basic auth over plain HTTP sends the password base64-encoded, not encrypted.
// It stops someone wandering in from a browser; it does not protect against
// anyone watching the traffic. Pair it with TLS_CERT_FILE/TLS_KEY_FILE.
func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	wantUser := getEnv("AUTH_USER", "")
	wantPass := getEnv("AUTH_PASS", "")

	if wantUser == "" || wantPass == "" {
		return next
	}

	return func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()

		// Compared with constant-time equality so a response cannot be timed to
		// recover the credentials character by character. Both comparisons run
		// unconditionally for the same reason.
		userOK := subtle.ConstantTimeCompare([]byte(user), []byte(wantUser)) == 1
		passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(wantPass)) == 1

		if !ok || !userOK || !passOK {
			w.Header().Set("WWW-Authenticate", `Basic realm="FetchFido", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func main() {
	initDisplayTZ()

	// Matches udpListener(): loopback inside a container only works by
	// accident of how rootless podman forwards ports.
	listenIP := getEnv("LISTEN_IP", "0.0.0.0")
	port := getEnv("PORT", "8080")
	listenPort := getEnv("LISTEN_PORT", "9998")
	tlsCertFile := getEnv("TLS_CERT_FILE", "")
	tlsKeyFile := getEnv("TLS_KEY_FILE", "")

	var err error
	htmlTemplates, err = htmltemplate.ParseGlob("templates/*.html")
	if err != nil {
		log.Fatal("Error loading HTML templates:", err)
	}

	jsTemplates, err = texttemplate.ParseFiles("templates/gps-data.js")
	if err != nil {
		log.Fatal("Error loading JS templates:", err)
	}

	capacity := maxMessages()
	dataStore = NewDataStore(capacity)
	log.Printf("Retaining up to %d messages", capacity)

	go udpListener()

	// /health is deliberately left open so a monitor or container healthcheck
	// does not need credentials. It reveals nothing but liveness. Everything
	// else either serves positions or changes state.
	http.Handle("/static/", http.StripPrefix("/static/",
		requireAuth(http.FileServer(http.Dir("static")).ServeHTTP)))
	http.HandleFunc("/", requireAuth(rootHandler))
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/info", requireAuth(infoHandler))
	http.HandleFunc("/messages", requireAuth(messagesHandler))
	http.HandleFunc("/events", requireAuth(eventsHandler))
	http.HandleFunc("/clear", requireAuth(clearHandler))
	http.HandleFunc("/gps-data.js", requireAuth(gpsDataHandler))
	http.HandleFunc("/export/csv", requireAuth(exportCSVHandler))

	if getEnv("AUTH_USER", "") != "" && getEnv("AUTH_PASS", "") != "" {
		log.Printf("Basic auth enabled (/health left open)")
	} else {
		log.Printf("Warning: no authentication. Set AUTH_USER and AUTH_PASS to require credentials.")
	}

	server := &http.Server{
		Addr: listenIP + ":" + port,
	}

	log.Printf("FetchFido server starting...")
	log.Printf("UDP listener: %s:%s", listenIP, listenPort)

	if tlsCertFile != "" && tlsKeyFile != "" {
		// Configure TLS 1.3 only
		server.TLSConfig = &tls.Config{
			MinVersion: tls.VersionTLS13,
			MaxVersion: tls.VersionTLS13,
		}
		log.Printf("HTTPS server: https://%s:%s", listenIP, port)
		log.Fatal(server.ListenAndServeTLS(tlsCertFile, tlsKeyFile))
	} else {
		log.Printf("HTTP server: http://%s:%s", listenIP, port)
		log.Printf("Warning: Running without TLS encryption. Set TLS_CERT_FILE and TLS_KEY_FILE for HTTPS.")
		log.Fatal(server.ListenAndServe())
	}
}
