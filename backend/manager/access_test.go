package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestManagementGuardIgnoresForgedIdentity(t *testing.T) {
	t.Setenv("HOMENET_ACCESS_ENABLED", "1")
	previous := gateClient
	defer func() { gateClient = previous }()
	role := "guest"
	gateClient = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 204, Header: http.Header{"X-Gate-Role": []string{role}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	a := &app{}
	for _, method := range []string{"GET", "POST"} {
		for _, path := range []string{"/api/routes", "/api/apply", "/api/access", "/api/nginx/config/read", "/api/cert/download", "/api/network/dns"} {
			r := httptest.NewRequest(method, "http://192.168.1.1:63412"+path, nil)
			r.Header.Set("X-Gate-Role", "admin")
			r.Header.Set("X-Auth-Role", "admin")
			w := httptest.NewRecorder()
			if !a.accessGuard(w, r) || w.Code != 403 {
				t.Fatalf("guest can reach %s %s", method, path)
			}
		}
	}
	role = "admin"
	r := httptest.NewRequest("GET", "http://192.168.1.1:63412/api/routes", nil)
	if a.accessGuard(httptest.NewRecorder(), r) {
		t.Fatal("admin blocked")
	}
	r = httptest.NewRequest("POST", "http://192.168.1.1:63412/api/access", strings.NewReader(`{"apps":{}}`))
	w := httptest.NewRecorder()
	a.accessGuard(w, r)
	if w.Code != 403 {
		t.Fatal("CSRF accepted")
	}
}
