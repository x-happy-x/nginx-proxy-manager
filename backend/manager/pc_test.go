package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func pcFixture(t *testing.T, ts int64) []byte {
	t.Helper()
	return []byte(fmt.Sprintf(`{"v":1,"ts":%d,"host":"office","os":"windows","arch":"amd64","agent":"1.0.0","uptime":1000,
"cpu":{"percent":25,"cores":8,"model":"CPU"},"memory":{"total":1000,"used":950,"available":50},
"disks":[{"path":"C:","total":1000,"used":920,"free":80}],"network":[{"name":"ethernet","rx_bytes":10000,"tx_bytes":20000,"aggregate":true},{"name":"vEthernet","rx_bytes":30000,"tx_bytes":40000,"aggregate":false}],
"wsl":[{"name":"Ubuntu","state":"running","version":2},{"name":"Debian","state":"stopped","version":2}],
"docker":[{"context":"native","available":true,"containers":[{"id":"%s","name":"web","image":"nginx","state":"running","status":"Up","ports":"80/tcp"}]},
{"context":"wsl:Ubuntu","available":true,"containers":[{"id":"%s","name":"db","image":"postgres","state":"exited","status":"Exited","ports":"5432/tcp"}]}],
"capabilities":{"docker_actions":["start","stop","restart"],"wsl_actions":["start","terminate"]},"errors":[]}`, ts, strings.Repeat("a", 64), strings.Repeat("b", 64)))
}

func pcTestMonitor(t *testing.T) *pcMonitor {
	t.Helper()
	var snap pcSnapshot
	if err := json.Unmarshal(pcFixture(t, time.Now().Unix()), &snap); err != nil {
		t.Fatal(err)
	}
	return &pcMonitor{dir: t.TempDir(), hosts: []*pcHost{{Config: pcHostConfig{ID: "office", Name: "Office", Address: "192.168.99.42", Port: 22, User: "Alice"}, Online: true, Current: &snap, Checked: time.Now(), LastOK: time.Now(), History: []pcSample{}}}}
}

func TestPCConfigPersistenceAndHostValidation(t *testing.T) {
	m := pcTestMonitor(t)
	for _, change := range []func(*pcHostConfig){
		func(h *pcHostConfig) { h.ID = "Office" }, func(h *pcHostConfig) { h.Address = "host;shutdown" }, func(h *pcHostConfig) { h.User = "-oProxyCommand=bad" }, func(h *pcHostConfig) { h.User = "" }, func(h *pcHostConfig) { h.Port = 65536 }, func(h *pcHostConfig) { h.Name = "" },
	} {
		cfg := m.hosts[0].Config
		change(&cfg)
		if validatePCHosts([]pcHostConfig{cfg}) == nil {
			t.Fatalf("accepted invalid config: %+v", cfg)
		}
	}
	cfg := m.hosts[0].Config
	if err := validatePCHosts([]pcHostConfig{cfg}); err != nil {
		t.Fatal("uppercase Windows user rejected", err)
	}
	if validatePCHosts([]pcHostConfig{cfg, cfg}) == nil {
		t.Fatal("duplicate host IDs accepted")
	}
	if err := m.saveHosts([]pcHostConfig{cfg}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_DIR", m.dir)
	loaded := newPCMonitor()
	if loaded.loadErr != "" || len(loaded.hosts) != 1 || loaded.hosts[0].Config != cfg {
		t.Fatalf("loaded %+v %s", loaded.hosts, loaded.loadErr)
	}
	original := m.hosts[0]
	cfg.Name = "Renamed"
	m.applyHosts([]pcHostConfig{cfg})
	if m.hosts[0] != original || m.hosts[0].Current == nil {
		t.Fatal("rename discarded collected state")
	}
	cfg.Address = "192.168.99.43"
	m.applyHosts([]pcHostConfig{cfg})
	if m.hosts[0] == original || m.hosts[0].Current != nil {
		t.Fatal("address change retained another computer's snapshot")
	}
}

func TestPCHistoryDiskPersistenceAndNetworkReset(t *testing.T) {
	m := pcTestMonitor(t)
	h := m.hosts[0]
	now := time.Now().Unix()
	h.Current.TS = now - 60
	h.Current.Network[0].RX = 30000
	h.Current.Network[0].TX = 40000
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		return pcFixture(t, now), "", nil
	}
	m.poll(h)
	point := h.History[0]
	if point.NetworkValid == nil || *point.NetworkValid || point.RX != 0 || point.TX != 0 {
		t.Fatalf("counter reset must not produce throughput: %+v", point)
	}
	h.Current.Disks[0].Used = 1
	if point.Disks[0].Used != 920 {
		t.Fatal("historical disks changed with current snapshot")
	}
	m.mu.Lock()
	m.saveStateLocked()
	m.mu.Unlock()
	if err := m.saveHosts([]pcHostConfig{h.Config}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PC_DIR", m.dir)
	loaded := newPCMonitor()
	if len(loaded.hosts[0].History) != 1 || loaded.hosts[0].History[0].Disks[0] != point.Disks[0] {
		t.Fatal("disk history not persisted")
	}
	var legacy pcSample
	if err := json.Unmarshal([]byte(`{"t":1,"cpu":25,"mem_used":10,"mem_total":20,"net_rx_bps":800,"net_tx_bps":1600}`), &legacy); err != nil || legacy.RX != 800 || len(legacy.Disks) != 0 || legacy.NetworkValid != nil {
		t.Fatalf("legacy sample incompatible: %+v %v", legacy, err)
	}
	previous := pcm
	pcm = m
	t.Cleanup(func() { pcm = previous })
	r := httptest.NewRecorder()
	(&app{}).handlePC(r, httptest.NewRequest("GET", "/api/pc/history?host=office", nil))
	var reply struct {
		Step   int        `json:"step"`
		Points []pcSample `json:"points"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &reply); r.Code != 200 || err != nil || reply.Step != 60 || len(reply.Points) != 1 || reply.Points[0].Disks[0].Used != 920 {
		t.Fatalf("history API: %d %s %v", r.Code, r.Body, err)
	}
}

func TestPCKnownHostIncludesPort(t *testing.T) {
	m := pcTestMonitor(t)
	if err := os.MkdirAll(filepath.Join(m.dir, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.dir, ".ssh", "known_hosts"), []byte("192.168.99.42 ssh-ed25519 AAAA\n[192.168.99.43]:2222 ssh-ed25519 BBBB\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := m.hosts[0].Config
	if !m.knownHost(cfg) {
		t.Fatal("default port key missing")
	}
	cfg.Port = 2222
	if m.knownHost(cfg) {
		t.Fatal("default port key incorrectly trusted for another service")
	}
	cfg.Address = "192.168.99.43"
	if !m.knownHost(cfg) {
		t.Fatal("explicit port key missing")
	}
	res := m.test(context.Background(), pcHostConfig{Address: "192.168.99.44", Port: 22}, false)
	if res["ok"] != false || res["pinned"] != false {
		t.Fatal(res)
	}
}

func TestPCPollingHistoryAndOfflineSnapshot(t *testing.T) {
	m := pcTestMonitor(t)
	h := m.hosts[0]
	now := time.Now().Unix()
	h.Current.TS = now - 60
	h.Current.Network[0].RX = 4000
	h.Current.Network[0].TX = 8000
	m.request = func(_ context.Context, _ pcHostConfig, command string, trust bool) ([]byte, string, error) {
		if command != "snapshot" || trust {
			t.Fatal(command, trust)
		}
		return pcFixture(t, now), "", nil
	}
	m.poll(h)
	if !h.Online || len(h.History) != 1 || h.History[0].RX != 800 || h.History[0].TX != 1600 {
		t.Fatalf("history %+v", h.History)
	}
	if h.History[0].NetworkValid == nil || !*h.History[0].NetworkValid || len(h.History[0].Disks) != 1 || h.History[0].Disks[0] != (pcDiskSample{Path: "C:", Used: 920, Total: 1000}) {
		t.Fatalf("network validity and disk usage missing: %+v", h.History[0])
	}
	m.poll(h)
	if len(h.History) != 1 {
		t.Fatal("more than one point per minute")
	}
	previous := h.Current
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		return nil, "", errors.New("offline")
	}
	m.poll(h)
	if h.Online || h.Error != "offline" || h.Current != previous {
		t.Fatal("offline state must keep last snapshot")
	}
	m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		return pcFixture(t, now-300), "", nil
	}
	m.poll(h)
	if h.Online || h.Current != previous {
		t.Fatal("stale snapshot accepted")
	}
	found := false
	for _, item := range m.attention() {
		if item["id"] == "office-offline" {
			found = true
		}
	}
	if !found {
		t.Fatal("offline host should report an attention item")
	}
}

func TestPCActionsRejectUnsafeOrStaleResources(t *testing.T) {
	base := pcAction{Host: "office", Target: "docker", Context: "native", ID: strings.Repeat("a", 64), Action: "stop", Confirm: "web"}
	tests := []struct {
		name   string
		change func(*pcAction, *pcMonitor)
		status int
	}{
		{"confirm", func(a *pcAction, m *pcMonitor) { a.Confirm = "" }, 400},
		{"unknown host", func(a *pcAction, m *pcMonitor) { a.Host = "missing" }, 404},
		{"command injection", func(a *pcAction, m *pcMonitor) { a.Action = "stop;rm" }, 400},
		{"unlisted context", func(a *pcAction, m *pcMonitor) { a.Context = "tcp://other:2375" }, 404},
		{"wrong container", func(a *pcAction, m *pcMonitor) { a.ID = strings.Repeat("c", 64) }, 404},
		{"short id", func(a *pcAction, m *pcMonitor) { a.ID = "aabbcc" }, 400},
		{"stale", func(a *pcAction, m *pcMonitor) { m.hosts[0].Current.TS -= 180 }, 409},
		{"offline", func(a *pcAction, m *pcMonitor) { m.hosts[0].Online = false }, 409},
		{"disabled", func(a *pcAction, m *pcMonitor) { m.hosts[0].Current.Capabilities.DockerActions = nil }, 403},
		{"running start", func(a *pcAction, m *pcMonitor) { a.Action = "start" }, 409},
		{"stopped stop", func(a *pcAction, m *pcMonitor) {
			a.Context = "wsl:Ubuntu"
			a.ID = strings.Repeat("b", 64)
			a.Confirm = "db"
		}, 409},
		{"wsl linux", func(a *pcAction, m *pcMonitor) {
			*a = pcAction{Host: "office", Target: "wsl", Name: "Ubuntu", Action: "terminate", Confirm: "Ubuntu"}
			m.hosts[0].Current.OS = "linux"
		}, 400},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := pcTestMonitor(t)
			action := base
			tt.change(&action, m)
			m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
				t.Fatal("unsafe command reached SSH")
				return nil, "", nil
			}
			_, status, err := m.submitAction(action)
			if err == nil || status != tt.status {
				t.Fatalf("status %d err %v", status, err)
			}
		})
	}
}

func TestPCControlUsesStructuredArgumentsAndBlocksConcurrentActions(t *testing.T) {
	m := pcTestMonitor(t)
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	m.request = func(_ context.Context, _ pcHostConfig, command string, trust bool) ([]byte, string, error) {
		calls.Add(1)
		if trust || !strings.HasPrefix(command, "control ") {
			t.Error("bad SSH request")
		}
		b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(command, "control "))
		if err != nil {
			t.Error(err)
		}
		var payload map[string]string
		if json.Unmarshal(b, &payload) != nil || len(payload) != 4 || payload["target"] != "docker" || payload["context"] != "wsl:Ubuntu" || payload["action"] != "start" || payload["id"] != strings.Repeat("b", 64) {
			t.Errorf("payload %s", b)
		}
		close(started)
		<-release
		return []byte(`{"ok":true,"message":"started"}`), "", nil
	}
	a := pcAction{Host: "office", Target: "docker", Context: "wsl:Ubuntu", ID: strings.Repeat("b", 64), Action: "start"}
	task, _, err := m.submitAction(a)
	if err != nil || task.Status != "running" {
		t.Fatalf("task %+v err %v", task, err)
	}
	<-started
	if _, status, err := m.submitAction(a); err == nil || status != 409 {
		t.Fatal("duplicate command accepted")
	}
	if _, status, err := m.submitAction(pcAction{Host: "office", Target: "wsl", Name: "Ubuntu", Action: "terminate", Confirm: "Ubuntu"}); err == nil || status != 409 {
		t.Fatal("WSL terminated while its Docker command was in flight")
	}
	close(release)
	workerTasks.Wait()
	if calls.Load() != 1 || m.taskList()[0].Status != "done" {
		t.Fatal("task result wrong", m.taskList())
	}
}

func TestPCUnknownMutationIsNeverRetried(t *testing.T) {
	for _, tt := range []struct {
		name, body, want string
		err              error
	}{
		{"timeout", "", "unknown", context.DeadlineExceeded},
		{"agent timeout", `{"ok":true,"unknown":true}`, "unknown", nil},
		{"invalid json", "oops", "unknown", nil},
		{"refused", `{"ok":false,"error":"disabled"}`, "error", errors.New("exit status 2")},
		{"success", `{"ok":true}`, "done", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			m := pcTestMonitor(t)
			calls := 0
			m.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
				calls++
				return []byte(tt.body), "", tt.err
			}
			_, _, err := m.submitAction(pcAction{Host: "office", Target: "wsl", Name: "Debian", Action: "start"})
			if err != nil {
				t.Fatal(err)
			}
			workerTasks.Wait()
			if calls != 1 || m.taskList()[0].Status != tt.want {
				t.Fatalf("tasks %+v calls %d", m.taskList(), calls)
			}
		})
	}
}

func TestPCHTTPMethodsAndCacheOnlyViews(t *testing.T) {
	old := pcm
	t.Cleanup(func() { pcm = old })
	pcm = pcTestMonitor(t)
	pcm.request = func(context.Context, pcHostConfig, string, bool) ([]byte, string, error) {
		t.Fatal("view unexpectedly contacted computer")
		return nil, "", nil
	}
	for _, path := range []string{"/api/pc/overview", "/api/pc/tasks", "/api/pc/history?host=office", "/api/pc/widgets/hosts", "/api/pc/summary/attention"} {
		rec := httptest.NewRecorder()
		(&app{}).handlePC(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 200 || !json.Valid(rec.Body.Bytes()) {
			t.Fatalf("GET %s %d %s", path, rec.Code, rec.Body.String())
		}
	}
	for _, path := range []string{"/api/pc/actions", "/api/pc/tasks", "/api/pc/overview", "/api/pc/config"} {
		rec := httptest.NewRecorder()
		(&app{}).handlePC(rec, httptest.NewRequest("DELETE", path, nil))
		if rec.Code != 405 {
			t.Fatalf("DELETE %s %d", path, rec.Code)
		}
	}
	for _, body := range []string{`{`, `{"host":"office","target":"wsl","name":"Debian","action":"start","shell":"bad"}`, `{} {}`} {
		rec := httptest.NewRecorder()
		(&app{}).handlePC(rec, httptest.NewRequest("POST", "/api/pc/actions", strings.NewReader(body)))
		if rec.Code != 400 {
			t.Fatalf("invalid action %s %d", body, rec.Code)
		}
	}
}

func TestPCModuleConnection(t *testing.T) {
	oldMonitor, oldKind := pcm, moduleKind
	t.Cleanup(func() { pcm, moduleKind = oldMonitor, oldKind })
	moduleKind = "pc"
	pcm = &pcMonitor{}
	if (&app{}).moduleConnection() != "unconfigured" {
		t.Fatal("empty module must be unconfigured")
	}
	pcm = pcTestMonitor(t)
	if (&app{}).moduleConnection() != "connected" {
		t.Fatal("online PC must be connected")
	}
	pcm.hosts[0].Current.TS -= 180
	if (&app{}).moduleConnection() != "unavailable" {
		t.Fatal("stale PC must be unavailable")
	}
	pcm.hosts[0].Online = false
	if (&app{}).moduleConnection() != "unavailable" {
		t.Fatal("offline PC must be unavailable")
	}
}
