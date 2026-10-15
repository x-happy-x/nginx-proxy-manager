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
			_, _ = w.Write([]byte(`{"providers":{"ROUTER":{"vehicleType":"HTTP","skipped":["654 \"Обход XI\": invalid REALITY short ID"],"proxies":[{"name":"A"},{"name":"B"},{"name":"C"}],"adaptive":{"mode":"whitelist","checkedAt":"2026-10-14T23:36:31Z","pending":2,"scan":{"running":true,"step":"nodes","total":3,"planned":3,"done":1,"ok":1},
"directAllowed":[{"url":"https://ya.ru","ok":true,"ms":217}],"directGlobal":[{"url":"https://www.google.com/generate_204","ok":false,"ms":5000,"fail":"silent"}],
"rankings":{"whitelist":[{"name":"A","record":{"avgMs":463,"lastMs":431,"checks":1574},"successRate":0.83,"stable":true},{"name":"B","record":{"avgMs":900,"lastMs":-1,"checks":40},"successRate":0.05,"stable":false},{"name":"C","record":{"checks":0},"successRate":0.5,"stable":false}],
"normal":[{"name":"A","record":{"avgMs":300,"lastMs":280,"checks":10},"successRate":0.9,"stable":true}]},
"results":{"A":{"ok":true,"available":true},"B":{"ok":false,"available":false,"probes":[{"url":"https://www.google.com/","ok":false,"fail":"tls"}]},"C":{"skipped":"mode"}}}},
"Cascade":{"proxies":[{"name":"X"}],"vehicleType":"File","adaptive":{"dependsOn":"ROUTER"}}}}`))
		case "/proxies":
			_, _ = w.Write([]byte(`{"proxies":{"AUTO":{"type":"Fallback","now":"Обходы"},"Обходы":{"type":"Fallback","now":"A","all":["A","B"]},"Headscale":{"type":"Fallback","now":"A","all":["B","A"]},"A":{"type":"Vless"},"ts":{"type":"Tailscale","alive":true}}}`))
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

	b := (&app{}).vpnBoard(7)
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
	if sc := p["scan"].(*boardScan); sc == nil || !sc.Running || sc.Done != 1 || len(p["skipped"].([]string)) != 1 {
		t.Fatalf("scan or skipped lost: %+v", p)
	}
	src := b["sources"].([]response)
	if len(src) != 3 || src[0]["name"] != "ROUTER" || src[0]["alive"] != 1 || src[1]["depends_on"] != "ROUTER" || src[2]["kind"] != "tailscale" || src[2]["alive"] != 1 {
		t.Fatalf("sources %+v", src)
	}
	n, code := (&app{}).vpnNode("A", "")
	gs := n["groups"].([]nodeGroup)
	if code != 200 || n["provider"] != "ROUTER" || n["now"] != "ok" || len(gs) != 2 || !gs[0].Leads || gs[0].Name != "Headscale" && gs[0].Name != "Обходы" {
		t.Fatalf("node %+v", n)
	}
	for _, g := range gs {
		if g.Name == "Обходы" && (g.Via != "AUTO" || g.Place != 1) || g.Name == "Headscale" && g.Place != 2 {
			t.Fatalf("group %+v", g)
		}
	}
	if m := n["modes"].(response); m["whitelist"] == nil || m["normal"] == nil {
		t.Fatalf("modes %+v", m)
	}
	// minutes counted twice never make a day longer than 24 hours
	today := time.Now().Truncate(time.Hour).Unix()
	traffic.st.Uplink = &providerHealth{Hours: []healthPoint{{T: today, Whitelist: 1500}, {T: today, Normal: 300}}}
	if d := traffic.boardWeek("ROUTER", time.Now(), 7)[6]; d.Normal+d.Whitelist+d.Offline+d.Unknown != 1440 || d.Whitelist < d.Normal {
		t.Fatalf("day over 24 h: %+v", d)
	}
	if month := (&app{}).vpnBoard(30)["week"].([]boardDay); len(month) != 30 {
		t.Fatalf("month %d", len(month))
	}
}
