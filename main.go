package main

import (
	"crypto/tls"
	"encoding/json"
	htmltemplate "html/template"
	"log"
	"net"
	"net/http"
	"os"
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

type GPSCoordinate struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Valid     bool    `json:"valid"`
}

type ReceivedMessage struct {
	Timestamp   time.Time     `json:"timestamp"`
	Data        string        `json:"data"`
	Source      string        `json:"source"`
	Coordinates GPSCoordinate `json:"coordinates"`
}

type DataStore struct {
	mu       sync.RWMutex
	messages []ReceivedMessage
	maxSize  int
}

func NewDataStore(maxSize int) *DataStore {
	return &DataStore{
		messages: make([]ReceivedMessage, 0),
		maxSize:  maxSize,
	}
}

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

	if len(parts) >= 2 {
		if lat, err := strconv.ParseFloat(parts[0], 64); err == nil {
			if lon, err := strconv.ParseFloat(parts[1], 64); err == nil {
				// Validate coordinate ranges
				if lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 {
					coords.Latitude = lat
					coords.Longitude = lon
					coords.Valid = true
				}
			}
		}
	}

	return coords
}

func (ds *DataStore) AddMessage(data, source string) {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	coordinates := parseGPSCoordinates(data)

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
}

func (ds *DataStore) GetMessages() []ReceivedMessage {
	ds.mu.RLock()
	defer ds.mu.RUnlock()

	result := make([]ReceivedMessage, len(ds.messages))
	copy(result, ds.messages)
	return result
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

	messages := dataStore.GetMessages()

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
	messages := dataStore.GetMessages()
	json.NewEncoder(w).Encode(messages)
}

func gpsDataHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")

	messages := dataStore.GetMessages()

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

	err := jsTemplates.ExecuteTemplate(w, "gps-data.js", data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
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

		log.Printf("Received UDP message from %s: %s", source, message)
		dataStore.AddMessage(message, source)
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
	http.HandleFunc("/gps-data.js", gpsDataHandler)

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
