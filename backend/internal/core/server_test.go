package core

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testServer(t *testing.T, role string, gateStatus int) *Server {
	t.Helper()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Gate-Login", "tester")
		w.Header().Set("X-Gate-Role", role)
		w.WriteHeader(gateStatus)
	}))
	t.Cleanup(gate.Close)
	dir := t.TempDir()
	t.Setenv("HOMENET_ACCESS_PATH", filepath.Join(dir, "access.json"))
	s, err := New(Config{StateDir: dir, StaticDir: dir, PackagesDir: dir, AccountURL: gate.URL, DMSURL: gate.URL}, "amd64")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestEmptyCoreIndependentOfRoutesAndDMS(t *testing.T) {
	s := testServer(t, "admin", 204)
	for _, path := range []string{"/health", "/api/platform", "/api/portal"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/dms/health", nil))
	if w.Code != 503 {
		t.Fatal("missing DMS should be explicit")
	}
}
func TestCoreAuthorizationAndCSRF(t *testing.T) {
	for _, tc := range []struct {
		role         string
		gate, status int
	}{{"user", 204, 403}, {"admin", 401, 401}, {"admin", 500, 503}, {"", 204, 403}} {
		s := testServer(t, tc.role, tc.gate)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/platform", nil)
		req.Header.Set("X-Gate-Role", "admin")
		s.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Fatalf("role %s: %d", tc.role, w.Code)
		}
	}
	s := testServer(t, "admin", 204)
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		for _, origin := range []string{"", "https://evil.invalid", "http://example.com.evil"} {
			r := httptest.NewRequest(method, "http://example.com/api/dms/install", strings.NewReader("{}"))
			r.Header.Set("Origin", origin)
			r.Header.Set("X-HomeNet-UI", "1")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatalf("%s %s accepted", method, origin)
			}
		}
	}
}

func TestAccountAdminCannotCallPrivateWorkerContract(t *testing.T) {
	s := testServer(t, "admin", 204)
	r := httptest.NewRequest("POST", "http://example.com/internal/proxy/vpn-dns/prepare", strings.NewReader(`{}`))
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-HomeNet-UI", "1")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("browser accessed private contract: %d", w.Code)
	}
}
func TestPortalFiltersIndependentCatalog(t *testing.T) {
	s := testServer(t, "user", 204)
	if err := os.WriteFile(filepath.Join(s.Config.StateDir, "catalog.json"), []byte(`[{"id":"public","title":"Visible","url":"http://example.com"},{"id":"private","title":"Hidden","url":"http://secret.invalid"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("HOMENET_ACCESS_PATH"), []byte(`{"apps":{"public":{"mode":"public"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/portal", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Visible") || strings.Contains(w.Body.String(), "secret.invalid") {
		t.Fatal(w.Body.String())
	}
}
