package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDMSProxyKeepsTokenServerSideAndStreamsLargeUpload(t *testing.T) {
	token := strings.Repeat("x", 32)
	file := filepath.Join(t.TempDir(), "token")
	os.WriteFile(file, []byte(token), 0600)
	t.Setenv("DMS_TOKEN_FILE", file)
	t.Setenv("HOMENET_ACCESS_ENABLED", "0")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("missing server token")
		}
		if r.URL.Path != "/v1/packages" {
			t.Error(r.URL.Path)
		}
		n, _ := io.Copy(io.Discard, r.Body)
		if n != 3<<20 {
			t.Errorf("truncated upload: %d", n)
		}
		w.WriteHeader(202)
		io.WriteString(w, `{"id":"job","status":"running"}`)
	}))
	defer upstream.Close()
	t.Setenv("DMS_API_URL", upstream.URL)
	a := &app{}
	res := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/dms/packages", strings.NewReader(strings.Repeat("a", 3<<20)))
	a.handle(res, req)
	if res.Code != 202 || strings.Contains(res.Body.String(), token) {
		t.Fatal(res.Code, res.Body.String())
	}
}
func TestDMSProxyRejectsCrossOriginAndUnsafeEndpoint(t *testing.T) {
	t.Setenv("HOMENET_ACCESS_ENABLED", "0")
	a := &app{}
	res := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/dms/install", nil)
	req.Header.Set("Origin", "https://evil.example")
	a.handle(res, req)
	if res.Code != 403 {
		t.Fatal(res.Code)
	}
	res = httptest.NewRecorder()
	a.handle(res, httptest.NewRequest("POST", "/api/dms/arbitrary", nil))
	if res.Code != 404 {
		t.Fatal(res.Code)
	}
}

func TestDMSWriteRequiresHomeNetAdmin(t *testing.T) {
	t.Setenv("HOMENET_ACCESS_ENABLED", "1")
	previous := gateClient
	defer func() { gateClient = previous }()
	gateClient = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 204, Header: http.Header{"X-Gate-Role": []string{"user"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	res := httptest.NewRecorder()
	(&app{}).handle(res, httptest.NewRequest("POST", "/api/dms/install", strings.NewReader(`{"url":"https://example.com/app"}`)))
	if res.Code != 403 {
		t.Fatalf("non-admin deployment allowed: %d", res.Code)
	}
}
