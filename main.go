package main

import (
	"crypto/tls"
	"encoding/csv"
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

type ReceivedMessage struct {
	Timestamp   time.Time     `json:"timestamp"`
	Data        string        `json:"data"`
	Source      string        `json:"source"`
	Coordinates GPSCoordinate `json:"coordinates"`
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

// AddMessage stores data only if it parses as GPS coordinates, and reports
// whether it was stored. Unparseable traffic is dropped so that broadcast
// noise on a shared network cannot evict real coordinates from the buffer.
func (ds *DataStore) AddMessage(data, source string) bool {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	coordinates := parseGPSCoordinates(data)
	if !coordinates.Valid {
		return false
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

	return true
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

	messages := dataStore.GetMessagesNewestFirst()

	data := struct {
		Messages     []ReceivedMessage
		MessageCount int
		ListenPort   string
		WebPort      string
	}{
		Messages:     messages,
		MessageCount: len(messages),
		ListenPort:   getEnv("LISTEN_PORT", "9999"),
		WebPort:      getEnv("PORT", "8080"),
	}

	err := htmlTemplates.ExecuteTemplate(w, "index.html", data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func messagesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	messages := dataStore.GetMessagesNewestFirst()
	json.NewEncoder(w).Encode(messages)
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
	// be drawn in the order the positions were captured.
	messages := dataStore.GetMessages()

	data := struct {
		Messages     []ReceivedMessage
		MessageCount int
		ListenPort   string
		WebPort      string
		Seq          uint64
	}{
		Messages:     messages,
		MessageCount: len(messages),
		ListenPort:   getEnv("LISTEN_PORT", "9999"),
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
		"Fix Time (UTC)", "Confidence (m)", "Satellites",
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
			fixTime = msg.Coordinates.FixTime.Format("2006-01-02 15:04:05")
		}
		if msg.Coordinates.Extended {
			confidence = strconv.FormatFloat(msg.Coordinates.Confidence, 'f', -1, 64)
			satellites = strconv.Itoa(msg.Coordinates.Satellites)
		}

		err := writer.Write([]string{
			msg.Timestamp.Format("2006-01-02 15:04:05"),
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
	listenIP := getEnv("LISTEN_IP", "127.0.0.1")
	listenPort := getEnv("LISTEN_PORT", "9999")
	addr, err := net.ResolveUDPAddr("udp", listenIP+":"+listenPort)
	if err != nil {
		log.Fatal("Error resolving UDP address:", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		log.Fatal("Error starting UDP listener:", err)
	}
	defer conn.Close()

	log.Printf("UDP listener started on port %s", listenPort)

	buffer := make([]byte, 1024)
	for {
		n, clientAddr, err := conn.ReadFromUDP(buffer)
		if err != nil {
			log.Printf("Error reading UDP message: %v", err)
			continue
		}

		message := string(buffer[:n])
		source := clientAddr.String()

		if !dataStore.AddMessage(message, source) {
			// Log the size only: dropped traffic is frequently binary and
			// would otherwise write control bytes straight to the terminal.
			log.Printf("Ignored non-GPS message from %s (%d bytes)", source, n)
			continue
		}

		log.Printf("Received UDP message from %s: %s", source, message)
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func main() {
	listenIP := getEnv("LISTEN_IP", "127.0.0.1")
	port := getEnv("PORT", "8080")
	listenPort := getEnv("LISTEN_PORT", "9999")
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

	dataStore = NewDataStore(100)

	go udpListener()

	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	http.HandleFunc("/", rootHandler)
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/info", infoHandler)
	http.HandleFunc("/messages", messagesHandler)
	http.HandleFunc("/events", eventsHandler)
	http.HandleFunc("/gps-data.js", gpsDataHandler)
	http.HandleFunc("/export/csv", exportCSVHandler)

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
