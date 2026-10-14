package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// NPM-70: the board reads the core's rankings per mode, what each node does now
// and which groups use it.
func TestVPNBoard(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/providers/proxies":
			_, _ = w.Write([]byte(`{"providers":{"ROUTER":{"proxies":[{"name":"A"},{"name":"B"},{"name":"C"}],"adaptive":{"mode":"whitelist","checkedAt":"2026-10-14T23:36:31Z","pending":2,
"directAllowed":[{"url":"https://ya.ru","ok":true,"ms":217}],"directGlobal":[{"url":"https://www.google.com/generate_204","ok":false,"ms":5000,"fail":"silent"}],
"rankings":{"whitelist":[{"name":"A","record":{"avgMs":463,"lastMs":431,"checks":1574},"successRate":0.83,"stable":true},{"name":"B","record":{"avgMs":900,"lastMs":-1,"checks":40},"successRate":0.05,"stable":false},{"name":"C","record":{"checks":0},"successRate":0.5,"stable":false}],
"normal":[{"name":"A","record":{"avgMs":300,"lastMs":280,"checks":10},"successRate":0.9,"stable":true}]},
"results":{"A":{"ok":true,"available":true},"B":{"ok":false,"available":false,"probes":[{"url":"https://www.google.com/","ok":false,"fail":"tls"}]},"C":{"skipped":"mode"}}}},
"Cascade":{"proxies":[{"name":"X"}],"adaptive":{"dependsOn":"ROUTER"}}}}`))
		case "/proxies":
			_, _ = w.Write([]byte(`{"proxies":{"AUTO":{"type":"Fallback","now":"A"},"Headscale":{"type":"Fallback","now":"A"},"A":{"type":"Vless"}}}`))
		case "/network":
			_, _ = w.Write([]byte(`{"mode":"whitelist","since":"2026-10-14T15:14:00Z"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer core.Close()
	t.Setenv("MIHOMO_CONTROLLER", core.URL)
	t.Setenv("MIHOMO_SECRET", "x")
	old, oldT := services, traffic
	t.Cleanup(func() { services, traffic = old, oldT })
	services = nil
	traffic = newTrafficCollector(filepath.Join(t.TempDir(), "t.json"), time.Now())

	b := (&app{}).vpnBoard()
	p := b["provider"].(response)
	if p["name"] != "ROUTER" || p["total"] != 3 || p["pending"] != 2 {
		t.Fatalf("provider %+v", p)
	}
	s := b["servers"].(response)
	if s["answering"] != 1 || s["fails"].(map[string]int)["tls"] != 1 || s["stable"].(map[string]int)["whitelist"] != 1 {
		t.Fatalf("servers %+v", s)
	}
	rows := s["rows"].(map[string][]boardServer)["whitelist"]
	if len(rows) != 3 || rows[0].Name != "A" || rows[0].Now != "ok" || len(rows[0].Selected) != 2 || rows[1].Now != "tls" && rows[2].Now != "tls" {
		t.Fatalf("rows %+v", rows)
	}
	bins := s["bins"].(map[string][]int)["whitelist"]
	if bins[8] != 1 || bins[0] != 1 {
		t.Fatalf("bins %v (a node never checked must not count)", bins)
	}
	ch := b["channel"].(response)
	direct := ch["direct"].([]response)
	if ch["mode"] != "whitelist" || len(direct) != 2 || direct[0]["host"] != "ya.ru" || direct[1]["fail"] != "silent" {
		t.Fatalf("channel %+v", ch)
	}
	if week := b["week"].([]boardDay); len(week) != 7 || week[6].Day != time.Now().Format("2006-01-02") {
		t.Fatalf("week %+v", week)
	}
}
