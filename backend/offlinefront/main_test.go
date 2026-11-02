package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestOfflineFrontKeepsHostAndAdaptsGatewayScheme(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "192.0.2.1:63412" {
			t.Errorf("host changed: %s", r.Host)
		}
		w.WriteHeader(204)
	}))
	defer core.Close()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Gate-Proto") != "https" {
			t.Error("Core's IP-origin scheme not adapted")
		}
		if r.Header.Get("Cookie") != "__Host-homenet_gate=opaque" {
			t.Error("session cookie lost")
		}
		w.WriteHeader(204)
	}))
	defer gate.Close()
	ui, shim, err := handlers(config{Host: "192.0.2.1:63412", Core: core.URL, Gateway: gate.URL})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "https://192.0.2.1:63412/", nil)
	w := httptest.NewRecorder()
	ui.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatalf("front: %d", w.Code)
	}
	r = httptest.NewRequest("GET", "http://127.0.0.1:63414/_gate/check", nil)
	r.RemoteAddr = "127.0.0.1:40000"
	r.Header.Set("X-Gate-Host", "192.0.2.1:63412")
	r.Header.Set("X-Gate-Proto", "http")
	r.Header.Set("Cookie", "__Host-homenet_gate=opaque")
	w = httptest.NewRecorder()
	shim.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatalf("shim: %d", w.Code)
	}
	r.RemoteAddr = "192.0.2.50:40000"
	w = httptest.NewRecorder()
	shim.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("remote caller reached gateway")
	}
	r.RemoteAddr = "127.0.0.1:40000"
	r.Header.Set("X-Gate-Host", "other.test")
	w = httptest.NewRecorder()
	shim.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("foreign origin reached gateway")
	}
}

func TestOfflineCertificateIsCreatedPerRouter(t *testing.T) {
	d := t.TempDir()
	cert, key := filepath.Join(d, "cert.pem"), filepath.Join(d, "key.pem")
	if err := newCertificate("192.0.2.1", cert, key); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(key)
	if err := newCertificate("192.0.2.1", cert, key); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(key)
	if string(a) == string(b) {
		t.Fatal("identity reused")
	}
	if _, err := localURL("http://192.0.2.1:8000"); err == nil {
		t.Fatal("external upstream accepted")
	}
}
