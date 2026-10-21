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

// A trimmed snapshot as written by homenet-pve-agent on s1.
const pvhFixture = `{"v":1,"host":"s1","ts":%TS%,"interval":10,
"node":{"cpu":22.8,"iowait":0.4,"load":[0.5,0.6,0.6],"threads":4,"freq_mhz":3019,"uptime":124834,
 "mem":{"total":16537620480,"avail":4727000000,"used":15800000000},"swap":{"total":0,"used":0},"cpu_temp":91.0},
"temps":[{"chip":"coretemp","label":"Package id 0","c":91.0,"crit":105}],
"guests":[{"vmid":100,"name":"home-server","type":"qemu","status":"running"},{"vmid":101,"name":"family-apps","type":"qemu","status":"stopped"},{"vmid":9999,"name":"tpl","type":"qemu","status":"stopped","template":true}],
"storage":[{"name":"local","used":95,"total":100,"active":true,"enabled":true},{"name":"nas","used":0,"total":0,"active":false,"enabled":true}],
"zfs":[{"name":"rpool","health":"DEGRADED"}],
"disks":[{"dev":"nvme0n1","model":"XG7000-1TB 2280","health":true,"temp":43,"wear":85}],
"failed_units":["pvescheduler.service"],"updates":253,
"backups":[{"id":"101","status":"ERROR: no space","end":%TS%}]}`

func pvhTestMonitor(t *testing.T, ts int64) *pvhMonitor {
	t.Helper()
	m := &pvhMonitor{dir: t.TempDir(), hosts: []*pvhHost{{Config: pvhHostConfig{ID: "s1", Name: "s1", Address: "192.168.99.10"}}}}
	raw := json.RawMessage(strings.ReplaceAll(pvhFixture, "%TS%", itoa64(ts)))
	var snap pvhSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatal(err)
	}
	h := m.hosts[0]
	h.Online, h.Current, h.Parsed, h.Checked, h.LastOK = true, raw, &snap, time.Now(), time.Now()
	return m
}

func itoa64(v int64) string { b, _ := json.Marshal(v); return string(b) }

func TestPVEAttention(t *testing.T) {
	m := pvhTestMonitor(t, time.Now().Unix())
	ids := map[string]string{}
	for _, item := range m.attention() {
		ids[item["id"].(string)] = item["severity"].(string)
	}
	for id, severity := range map[string]string{
		"s1-cpu-temp": "warning", "s1-mem": "warning", "s1-st-local": "warning", "s1-st-nas": "warning",
		"s1-zfs-rpool": "critical", "s1-wear-nvme0n1": "warning", "s1-units": "warning", "s1-backup-101": "warning",
	} {
		if ids[id] != severity {
			t.Errorf("%s: got %q, want %q (all: %v)", id, ids[id], severity, ids)
		}
	}
	if _, ok := ids["s1-smart-nvme0n1"]; ok {
		t.Error("healthy SMART reported")
	}
	if first := m.attention()[0]; first["severity"] != "critical" {
		t.Errorf("critical items first, got %v", first)
	}
}

func TestPVEWidgets(t *testing.T) {
	m := pvhTestMonitor(t, time.Now().Unix())
	g := m.widgetGuests()
	if body := g["body"].(response); body["value"] != "1" {
		t.Errorf("running guests: %v", body)
	}
	if !strings.Contains(g["note"].(string), "всего 2") {
		t.Errorf("templates must not count: %v", g["note"])
	}
	temps := m.widgetTemps()
	if temps["state"] != "bad" {
		t.Errorf("91 °C CPU is bad, got %v", temps["state"])
	}
	hosts := m.widgetHosts()
	if hosts["state"] != "warn" {
		t.Errorf("attention present → warn, got %v", hosts["state"])
	}
	for _, w := range []response{g, temps, hosts} {
		b, _ := json.Marshal(w)
		if len(b) > 16<<10 {
			t.Errorf("widget over 16 KB")
		}
	}
}

func TestPVEOfflineAndOverview(t *testing.T) {
	m := pvhTestMonitor(t, time.Now().Unix())
	h := m.hosts[0]
	h.Online, h.Error, h.Since = false, "connection refused", time.Now()
	items := m.attention()
	if len(items) != 1 || items[0]["severity"] != "critical" || !strings.Contains(items[0]["text"].(string), "не отвечает") {
		t.Fatalf("offline host: %v", items)
	}
	pvh = m
	rec := httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("GET", "/api/pve/overview", nil))
	var out struct {
		Hosts []struct {
			ID      string          `json:"id"`
			Online  bool            `json:"online"`
			Current json.RawMessage `json:"current"`
		} `json:"hosts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Hosts) != 1 || out.Hosts[0].Online || len(out.Hosts[0].Current) < 100 {
		t.Fatalf("overview keeps the last snapshot of an offline host: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("POST", "/api/pve/overview", nil))
	if rec.Code != 405 {
		t.Errorf("read-only API, got %d", rec.Code)
	}
}

func TestPVEConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PVE_DIR", dir)
	if m := newPVHMonitor(); m.loadErr != "" || len(m.hosts) != 0 {
		t.Fatal("missing hosts.json is an empty list to fill on the settings page")
	}
	_ = os.WriteFile(filepath.Join(dir, "hosts.json"), []byte(`{`), 0600)
	if m := newPVHMonitor(); m.loadErr == "" {
		t.Fatal("a damaged list must be reported")
	}
	_ = os.WriteFile(filepath.Join(dir, "hosts.json"), []byte(`{"hosts":[{"id":"s1","address":"192.168.99.10"},{"id":"","address":"x"}]}`), 0600)
	m := newPVHMonitor()
	if m.loadErr != "" || len(m.hosts) != 1 || m.hosts[0].Config.Port != 22 || m.hosts[0].Config.User != "root" || m.hosts[0].Config.Name != "s1" {
		t.Fatalf("defaults: %+v %s", m.hosts, m.loadErr)
	}
}

func TestPVEConfigAPI(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PVE_DIR", dir)
	t.Setenv("PVE_KEYGEN", filepath.Join(dir, "absent-keygen"))
	pvh = newPVHMonitor()
	if pvh.loadErr != "" || len(pvh.hosts) != 0 {
		t.Fatalf("no hosts.json is an empty list, not an error: %q", pvh.loadErr)
	}
	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		(&app{}).handlePVE(rec, httptest.NewRequest("PUT", "/api/pve/config", strings.NewReader(body)))
		return rec
	}
	for _, bad := range []string{
		`{"hosts":[{"id":"S1","name":"s1","address":"192.168.99.10"}]}`,
		`{"hosts":[{"id":"s1","name":"s1","address":"192.168.99.10"},{"id":"s1","name":"x","address":"192.168.99.20"}]}`,
		`{"hosts":[{"id":"s1","name":"s1","address":"bad host;rm"}]}`,
		`{"hosts":[{"id":"s1","name":"","address":"192.168.99.10"}]}`,
		`{"hosts":[{"id":"s1","name":"s1","address":"192.168.99.10","port":70000}]}`,
	} {
		if rec := put(bad); rec.Code != 400 {
			t.Errorf("%s: want 400, got %d %s", bad, rec.Code, rec.Body.String())
		}
	}
	if rec := put(`{"hosts":[{"id":"s1","name":"s1","address":"192.168.99.10"},{"id":"s3","name":"s3","address":"192.168.99.30","port":22,"user":"root"}]}`); rec.Code != 200 {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	if len(pvh.hosts) != 2 || pvh.hosts[0].Config.Port != 22 || pvh.hosts[0].Config.User != "root" {
		t.Fatalf("applied without restart: %+v", pvh.hosts)
	}
	kept := pvh.hosts[1]
	if rec := put(`{"hosts":[{"id":"s3","name":"S3","address":"192.168.99.30"}]}`); rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if len(pvh.hosts) != 1 || pvh.hosts[0] != kept || pvh.hosts[0].Config.Name != "S3" {
		t.Fatalf("rename keeps collected state, removal drops the server: %+v", pvh.hosts[0])
	}
	b, _ := os.ReadFile(filepath.Join(dir, "hosts.json"))
	if again, err := parsePVHConfig(b); err != nil || len(again) != 1 || again[0].Name != "S3" {
		t.Fatalf("persisted: %s %v", b, err)
	}
	rec := httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("GET", "/api/pve/config", nil))
	if !strings.Contains(rec.Body.String(), `"pinned":false`) || !strings.Contains(rec.Body.String(), "key_error") {
		t.Errorf("config view: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	(&app{}).handlePVE(rec, httptest.NewRequest("POST", "/api/pve/config/test", strings.NewReader(`{"address":"192.168.99.30"}`)))
	if !strings.Contains(rec.Body.String(), "не закреплён") {
		t.Errorf("an unpinned host is not contacted without trust: %s", rec.Body.String())
	}
}

func TestPVEClusterAttention(t *testing.T) {
	m := pvhTestMonitor(t, time.Now().Unix())
	second := &pvhHost{Config: pvhHostConfig{ID: "s2", Name: "s2"}, Online: true, Parsed: m.hosts[0].Parsed}
	m.hosts = append(m.hosts, second)
	s := m.hosts[0].Parsed
	s.Cluster.Name, s.Cluster.Quorate = "proxmox", false
	s.Cluster.Nodes = append(s.Cluster.Nodes, struct {
		Name   string `json:"name"`
		IP     string `json:"ip"`
		Online bool   `json:"online"`
	}{"s3", "192.168.99.30", false})
	count := map[string]int{}
	for _, item := range m.attention() {
		count[item["id"].(string)]++
	}
	if count["cluster-quorum"] != 1 || count["cluster-node-s3"] != 1 {
		t.Errorf("cluster problems once, whoever reports them: %v", count)
	}
}
