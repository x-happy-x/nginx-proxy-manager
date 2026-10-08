//go:build integration_worker

package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	flags "flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

// Set separately for each package at link time; the installed manifest must match.
var workerID string

func main() {
	manifestFile := flags.String("manifest", "", "Installed integration manifest")
	tokenFile := flags.String("token-file", "", "Server-only Core credential")
	flags.Parse()
	if workerID != "proxy" && workerID != "network" && workerID != "vpn" {
		log.Fatal("worker identity not set at build time")
	}
	var manifest integration.Manifest
	b, err := os.ReadFile(*manifestFile)
	if err != nil {
		log.Fatal(err)
	}
	if err = json.Unmarshal(b, &manifest); err != nil {
		log.Fatal(err)
	}
	if err = manifest.Validate(runtime.GOARCH); err != nil {
		log.Fatal(err)
	}
	if manifest.ID != workerID {
		log.Fatal("worker identity does not match manifest")
	}
	b, err = os.ReadFile(*tokenFile)
	if err != nil {
		log.Fatal(err)
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 32 {
		log.Fatal("invalid worker credential")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	workerContext = ctx
	moduleKind, moduleTokenFile = workerID, *tokenFile
	a, err := newManager()
	if err != nil {
		log.Fatal(err)
	}
	listen := strings.TrimSuffix(strings.TrimPrefix(manifest.Backend.Endpoint, "http://"), "/")
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	switch workerID {
	case "proxy":
		a.startTelemetry()
		a.startMaintenance()
	case "network":
		a.startResources()
		a.startNetwork()
	case "vpn":
		a.startMihomoTraffic()
		a.startServiceChecks()
		a.startOlcrtc()
		a.startExits()
		a.startTorrents()
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.URL.Path == manifest.Backend.Health && r.Method == "GET" {
			a.writeJSON(w, 200, response{"status": "ok", "integration": workerID, "version": manifest.Version})
			return
		}
		if workerID == "vpn" && strings.HasPrefix(r.URL.Path, "/internal/vpn-dns/") {
			a.handleVPNDNSTransaction(w, r)
			return
		}
		if r.URL.Path == "/internal/connection" && r.Method == "GET" {
			a.writeJSON(w, 200, response{"connection": a.moduleConnection()})
			return
		}
		if !manifest.Allows(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		if workerID == "vpn" && r.Method != "GET" {
			if err := vpnDNSPending(""); err != nil {
				http.Error(w, err.Error(), 409)
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		if strings.HasPrefix(r.URL.Path, mihomoAPIPrefix+"/") {
			a.handleMihomoAPI(w, r)
			return
		}
		switch r.Method {
		case "GET":
			a.handleGet(w, r)
		case "POST":
			if strings.HasPrefix(r.URL.Path, "/api/network/") {
				a.handleNetworkPost(w, r)
				return
			}
			a.operationMu.Lock()
			defer a.operationMu.Unlock()
			a.handlePost(w, r)
		default:
			http.Error(w, "method not allowed", 405)
		}
	})
	server := &http.Server{Addr: strings.TrimSuffix(listen, "/"), Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		// Finish active requests and their device jobs before releasing ownership.
		_ = server.Shutdown(context.Background())
		workerTasks.Wait()
		close(done)
	}()
	log.Print(fmt.Sprintf("HomeNet %s %s listening on %s", workerID, manifest.Version, server.Addr))
	if err = server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	<-done
}
