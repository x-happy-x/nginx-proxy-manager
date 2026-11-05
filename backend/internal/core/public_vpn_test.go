package core

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

func TestPublicVPNContractUsesProxyCredentialAndForwardsToVPN(t *testing.T) {
	s := testServer(t, "", 401)
	proxyToken := strings.Repeat("p", 40)
	vpnToken := strings.Repeat("v", 40)
	dir := filepath.Join(s.Config.StateDir, "credentials")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, token := range map[string]string{"proxy": proxyToken, "vpn": vpnToken} {
		if err := os.WriteFile(filepath.Join(dir, name+".token"), []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var calls atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/internal/public-vpn/status" || r.Header.Get("Authorization") != "Bearer "+vpnToken {
			t.Error("private contract reached the wrong worker/credential")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"group":"HomeNet VPS cdn6"}`))
	}))
	defer worker.Close()
	manifest := func(id, endpoint string) integration.Manifest {
		return integration.Manifest{Schema: 1, ID: id, Name: id, Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 1, DataSchema: 1, Package: "homenet-" + id, UI: integration.UI{Entry: "entry.js", Pages: []integration.Page{{ID: id, Title: id}}}, Backend: integration.Backend{Endpoint: endpoint, Health: "/health", Paths: []string{"/api/" + id + "/"}, Service: "S90" + id}}
	}
	if err := s.Registry.Replace([]integration.Installed{{Manifest: manifest("proxy", "http://127.0.0.1:1"), Enabled: true, Connection: "connected"}, {Manifest: manifest("vpn", worker.URL), Enabled: true, Connection: "connected"}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		token, path string
		status      int
	}{{vpnToken, "status", 401}, {proxyToken, "status", 200}, {proxyToken, "arbitrary", 404}} {
		req := httptest.NewRequest("POST", "/internal/proxy/public-vpn/"+tc.path, strings.NewReader(`{"id":"cdn6"}`))
		req.Header.Set("Authorization", "Bearer "+tc.token)
		out := httptest.NewRecorder()
		s.ServeHTTP(out, req)
		if out.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.path, out.Code, out.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("unexpected number of private VPN calls: %d", calls.Load())
	}
}
