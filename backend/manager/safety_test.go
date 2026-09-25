package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStatsFiltersAndLatency(t *testing.T) {
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	items := []map[string]any{
		{"time": now.Add(-time.Minute).Format(time.RFC3339), "host": "sub.local", "status": "200", "request_time": "0.020", "bytes_sent": "100", "traffic_source": "local"},
		{"time": now.Add(-time.Minute).Format(time.RFC3339), "host": "sub.public.test", "status": "502", "request_time": "0.100", "bytes_sent": "30", "traffic_source": "external"},
		{"time": now.Add(-2 * time.Hour).Format(time.RFC3339), "host": "old.local", "status": "500"},
		{"time": now.Add(time.Minute).Format(time.RFC3339), "host": "future.local", "status": "500"},
	}
	stats := aggregateLogs(items, logSample{}, now, time.Hour, "", "")
	if stats["total_requests"] != 2 || stats["error_rate"] != float64(50) || stats["avg_latency_ms"] != float64(60) || stats["p95_latency_ms"] != float64(100) {
		t.Fatalf("unexpected stats: %+v", stats)
	}
	filtered := aggregateLogs(items, logSample{}, now, time.Hour, "", "local")
	if filtered["total_requests"] != 1 || filtered["bytes_sent"] != int64(100) {
		t.Fatal(filtered)
	}
	if logTraffic(map[string]any{"http_x_forwarded_for": "8.8.8.8", "server_port": "80"}) != "unknown" {
		t.Fatal("legacy logs/headers must not masquerade as listener evidence")
	}
}

func TestLogsBoundedAndMalformed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.log")
	line := `{"time":"2026-09-21T12:00:00Z","status":"200","request_time":"0.01","traffic_source":"local"}` + "\n"
	if err := os.WriteFile(path, []byte(strings.Repeat("x", int(maxLogBytes))+"\n"+line+"invalid\n"+`{"unfinished":`), 0600); err != nil {
		t.Fatal(err)
	}
	items, sample, err := readLogRecords(path)
	if err != nil || len(items) != 1 || !sample.Truncated || sample.MalformedLines != 1 {
		t.Fatalf("items=%v sample=%+v err=%v", items, sample, err)
	}
	for _, limit := range []int{-10, 0, 1, 9999999} {
		if _, err := readRouteLogs(path, limit, "", 0, 0); err != nil {
			t.Fatal(err)
		}
	}
}

func TestProxyUpdateNeverDeletesUnchangedProxy(t *testing.T) {
	p := ndnsProxy{Name: "sub", Domain: "ndns", SSLRedirect: true, SecurityLevel: "public"}
	p.Upstream.Proto = "http"
	p.Upstream.Target = "192.168.99.20"
	p.Upstream.Port = "4192"
	if commands := proxyCommands(p, &p); len(commands) != 0 {
		t.Fatal(commands)
	}
	next := p
	next.Upstream.Target = "192.168.1.2"
	next.Upstream.Port = "24092"
	commands := proxyCommands(next, &p)
	if len(commands) != 1 || commands[0] != "ip http proxy sub upstream http 192.168.1.2 24092" {
		t.Fatal(commands)
	}
}

func TestRouterArgumentsRejectInjection(t *testing.T) {
	for _, host := range []string{"sub.local; system reboot", "../ca", "x\nip host evil 1.2.3.4", "-bad.local", ""} {
		if validRouterHost(host) {
			t.Fatal(host)
		}
	}
	if !validRouterHost("sub.crubs.crazedns.ru") || !validRouterTarget("02:eb:bd:a3:6a:36") {
		t.Fatal("valid router arguments rejected")
	}
	_, err := proxyFromPayload(map[string]any{"name": "sub;reboot"})
	if err == nil {
		t.Fatal("invalid payload accepted")
	}
}

func TestCrossOriginWriteDenied(t *testing.T) {
	a := &app{}
	r := httptest.NewRequest("POST", "http://homenet.local/api/apply", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://untrusted.example")
	w := httptest.NewRecorder()
	a.handle(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestStatsEmptyAndInvalidWindow(t *testing.T) {
	a := &app{routeAccessLog: filepath.Join(t.TempDir(), "absent.log")}
	w := httptest.NewRecorder()
	a.handle(w, httptest.NewRequest("GET", "/api/nginx/stats?window=1h", nil))
	var body map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body["ok"] != true {
		t.Fatal(w.Body.String())
	}
	w = httptest.NewRecorder()
	a.handle(w, httptest.NewRequest("GET", "/api/nginx/stats?window=300h", nil))
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
