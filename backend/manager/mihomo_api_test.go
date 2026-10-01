package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMihomoPathAllowlist(t *testing.T) {
	allowed := [][2]string{
		{"GET", "/proxies"},
		{"PUT", "/proxies/PROXY"},
		{"PUT", "/proxies/%F0%9F%9A%80%20Auto"},
		{"GET", "/proxies/NL-1/delay"},
		{"GET", "/providers/proxies/ROUTER"},
		{"PUT", "/providers/proxies/ROUTER/proxies/node-1"},
		{"DELETE", "/connections/abc-123"},
		{"PATCH", "/configs"},
		{"GET", "/traffic"},
	}
	for _, c := range allowed {
		if !mihomoPathAllowed(c[0], c[1]) {
			t.Errorf("%s %s should be allowed", c[0], c[1])
		}
	}
	denied := [][2]string{
		{"POST", "/upgrade/ui"},
		{"PUT", "/storage/zashboard"},
		{"GET", "/debug/pprof"},
		{"DELETE", "/proxies/a/b"},
		{"GET", "/proxies/../configs"},
		{"POST", "/proxies"},
		{"GET", "/ui/index.html"},
	}
	for _, c := range denied {
		if mihomoPathAllowed(c[0], c[1]) {
			t.Errorf("%s %s should be denied", c[0], c[1])
		}
	}
}

func TestMihomoBodyRules(t *testing.T) {
	if err := checkMihomoBody("PUT", "/configs", []byte(`{"path":"","payload":""}`)); err != nil {
		t.Fatal(err)
	}
	if checkMihomoBody("PUT", "/configs", []byte(`{"path":"/etc/shadow"}`)) == nil {
		t.Fatal("arbitrary config path must be refused")
	}
	if checkMihomoBody("PUT", "/configs", []byte(`{"payload":"mixed-port: 1"}`)) == nil {
		t.Fatal("inline payload must be refused")
	}
	if err := checkMihomoBody("PATCH", "/configs", []byte(`{"mode":"global","tun":{"enable":true}}`)); err != nil {
		t.Fatal(err)
	}
	if checkMihomoBody("PATCH", "/configs", []byte(`{"external-controller":"0.0.0.0:9090"}`)) == nil {
		t.Fatal("controller address must not be patchable")
	}
}

func TestMihomoBridgeInjectsSecretAndStripsBrowserCredentials(t *testing.T) {
	var gotPath, gotQuery, gotAuth, gotCookie string
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.EscapedPath(), r.URL.RawQuery
		gotAuth, gotCookie = r.Header.Get("Authorization"), r.Header.Get("Cookie")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write([]byte(`{"delay":84}`))
	}))
	defer controller.Close()
	t.Setenv("MIHOMO_CONTROLLER", controller.URL)
	t.Setenv("MIHOMO_SECRET", "s3cret")
	a := &app{}

	req := httptest.NewRequest("GET", "/api/mihomo/proxies/NL%20Amsterdam/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&token=leak", nil)
	req.Header.Set("Cookie", "homenet_session=abc")
	req.Header.Set("Authorization", "Basic Zm9vOmJhcg==")
	rec := httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "84") {
		t.Fatalf("unexpected response %d %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/proxies/NL%20Amsterdam/delay" {
		t.Fatalf("path not preserved: %s", gotPath)
	}
	if strings.Contains(gotQuery, "token") || !strings.Contains(gotQuery, "timeout=5000") {
		t.Fatalf("query not filtered: %s", gotQuery)
	}
	if gotAuth != "Bearer s3cret" || gotCookie != "" {
		t.Fatalf("credentials leaked or secret missing: auth=%q cookie=%q", gotAuth, gotCookie)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS header must not be forwarded")
	}
}

func TestMihomoBridgeRefusesCrossOriginAndForeignController(t *testing.T) {
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("controller must not be reached")
	}))
	defer controller.Close()
	t.Setenv("MIHOMO_CONTROLLER", controller.URL)
	a := &app{}

	req := httptest.NewRequest("GET", "/api/mihomo/logs", nil)
	req.Host = "192.168.1.1:63412"
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin websocket must be refused, got %d", rec.Code)
	}

	req = httptest.NewRequest("DELETE", "/api/mihomo/connections", nil)
	req.Host = "192.168.1.1:63412"
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec = httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-site write must be refused, got %d", rec.Code)
	}

	t.Setenv("MIHOMO_CONTROLLER", "http://10.0.0.5:9090")
	req = httptest.NewRequest("GET", "/api/mihomo/version", nil)
	rec = httptest.NewRecorder()
	a.handle(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("non-loopback controller must be refused, got %d", rec.Code)
	}
}
