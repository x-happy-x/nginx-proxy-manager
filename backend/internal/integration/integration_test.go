package integration

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(id string) Manifest {
	return Manifest{Schema: 1, ID: id, Name: id, Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 1, Package: "homenet-" + id, DataSchema: 1,
		UI: UI{Entry: "entry.js", Pages: []Page{{ID: id, Title: id}}}, Backend: Backend{Endpoint: "http://127.0.0.1:64001", Health: "/health", Paths: []string{"/api/items/", "/api/status"}, Service: "S90homenet-" + id}}
}
func TestAllCombinationsAndPersistence(t *testing.T) {
	for mask := 0; mask < 8; mask++ {
		file := filepath.Join(t.TempDir(), "core", "registry.json")
		r, err := Open(file, "amd64")
		if err != nil {
			t.Fatal(err)
		}
		items := []Installed{}
		for i, id := range []string{"proxy", "network", "vpn"} {
			if mask&(1<<i) != 0 {
				items = append(items, Installed{fixture(id), true, "unconfigured"})
			}
		}
		if err = r.Replace(items); err != nil {
			t.Fatal(err)
		}
		r, err = Open(file, "amd64")
		if err != nil {
			t.Fatal(err)
		}
		if len(r.Snapshot()) != len(items) {
			t.Fatal("lost installed packages")
		}
		if len(items) > 0 {
			copy := r.Snapshot()
			copy[0].Manifest.Backend.Paths[0] = "/changed"
			if r.Snapshot()[0].Manifest.Backend.Paths[0] == "/changed" {
				t.Fatal("mutable registry snapshot")
			}
		}
	}
}
func TestRejectInvalidCandidateWithoutLosingRegistry(t *testing.T) {
	r, _ := Open(filepath.Join(t.TempDir(), "registry.json"), "amd64")
	p, v := fixture("proxy"), fixture("vpn")
	p.Dependencies = []Dependency{{ID: "vpn", Version: "1.0.0"}}
	good := []Installed{{p, true, "connected"}, {v, true, "connected"}}
	if err := r.Replace(good); err != nil {
		t.Fatal(err)
	}
	bad := clone(good)
	bad[1].Enabled = false
	if err := r.Replace(bad); err == nil {
		t.Fatal("disabled required dependency accepted")
	}
	if !r.Snapshot()[1].Enabled {
		t.Fatal("failed candidate changed state")
	}
	v.Dependencies = []Dependency{{ID: "proxy", Version: "1.0.0"}}
	if err := ValidateSet([]Manifest{p, v}, "amd64"); err == nil {
		t.Fatal("dependency cycle accepted")
	}
	v = fixture("vpn")
	v.Version = "2.0.0"
	if err := ValidateSet([]Manifest{p, v}, "amd64"); err == nil {
		t.Fatal("incompatible consumer accepted")
	}
}
func TestManifestBoundaries(t *testing.T) {
	for _, endpoint := range []string{"http://192.168.1.1:80", "http://localhost:80", "http://127.0.0.1", "http://u:p@127.0.0.1:80", "http://127.0.0.1:80/x"} {
		m := fixture("vpn")
		m.Backend.Endpoint = endpoint
		if m.Validate("amd64") == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	for _, entry := range []string{"../entry.js", "/entry.js", "a/../../x", "https://evil/x", "a%2f..%2fx"} {
		m := fixture("vpn")
		m.UI.Entry = entry
		if m.Validate("amd64") == nil {
			t.Fatalf("accepted asset %s", entry)
		}
	}
	m := fixture("vpn")
	for _, p := range []string{"/api/status-delete", "/api/items/../delete", "/api/items/%2e%2e/delete", "/api/private"} {
		if m.Allows(p) {
			t.Fatalf("allowed %s", p)
		}
	}
	if !m.Allows("/api/items/42") || !m.Allows("/api/status") {
		t.Fatal("allowed API rejected")
	}
}
func TestGatewayStripsBrowserCredentialsAndRejectsRedirect(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Gate-Role") != "" || r.Header.Get("Authorization") != "Bearer private" {
			t.Error("unsafe worker headers")
		}
		if r.URL.Path == "/api/items/redirect" {
			http.Redirect(w, r, "http://example.invalid", 302)
			return
		}
		w.Header().Set("Set-Cookie", "secret=1")
		io.WriteString(w, "ok")
	}))
	defer worker.Close()
	r, _ := Open(filepath.Join(t.TempDir(), "registry.json"), "amd64")
	m := fixture("vpn")
	m.Backend.Endpoint = worker.URL
	if err := r.Replace([]Installed{{m, true, "connected"}}); err != nil {
		t.Fatal(err)
	}
	g := Gateway{Registry: r, Token: func(string) (string, error) { return "private", nil }}
	for _, tc := range []struct {
		path   string
		status int
	}{{"/api/status", 200}, {"/api/private", 403}, {"/api/items/redirect", 502}} {
		req := httptest.NewRequest("GET", "/api/integrations/vpn"+tc.path, nil)
		req.Header.Set("Cookie", "session=secret")
		req.Header.Set("X-Gate-Role", "admin")
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		if w.Code != tc.status || w.Header().Get("Set-Cookie") != "" || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("unexpected response %d %s", w.Code, w.Body.String())
		}
	}
}
