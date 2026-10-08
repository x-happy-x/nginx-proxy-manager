//go:build !integration_worker

package main

import (
	"fmt"
	"log"
	"net/http"
	"time"
)

func main() {
	a, err := newManager()
	if err != nil {
		log.Fatal(err)
	}
	a.startTelemetry()
	a.startResources()
	a.startNetwork()
	a.startMihomoTraffic()
	a.startServiceChecks()
	a.startOlcrtc()
	a.startExits()
	a.startTorrents()

	a.startMaintenance()
	host, port := a.readUIBind()
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.handle)
	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", host, port),
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	log.Printf("manager listening on %s:%d", host, port)
	log.Fatal(server.ListenAndServe())
}
