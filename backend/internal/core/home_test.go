package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

type homeFixture struct {
	s     *Server
	login atomic.Value
	slow  atomic.Bool
	calls atomic.Int32
}

func newHomeFixture(t *testing.T) *homeFixture {
	t.Helper()
	f := &homeFixture{}
	f.login.Store("alice")
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Gate-Login", f.login.Load().(string))
		w.Header().Set("X-Gate-Role", "admin")
		w.WriteHeader(204)
	}))
	t.Cleanup(gate.Close)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("k", 40) {
			w.WriteHeader(401)
			return
		}
		f.calls.Add(1)
		if f.slow.Load() {
			time.Sleep(400 * time.Millisecond)
		}
		switch r.URL.Path {
		case "/api/vpn/widgets/channel":
			_, _ = w.Write([]byte(`{"state":"warn","updated_at":"2026-10-14T00:24:00Z","note":"с 15:14","body":{"label":"Белые списки"}}`))
		case "/api/vpn/widgets/traffic":
			_, _ = w.Write([]byte(`{"state":"ok","body":{"value":"255,8","unit":"ГБ"}}`))
		case "/api/vpn/widgets/huge":
			_, _ = w.Write([]byte(`{"state":"ok","body":{"x":"` + strings.Repeat("a", 20<<10) + `"}}`))
		case "/api/vpn/summary/attention":
			_, _ = w.Write([]byte(`{"items":[{"id":"a","severity":"info","text":"инфо"},{"id":"b","severity":"critical","text":"Headscale не проходит /health","action":{"label":"Разобрать","page":"vpn/groups"}},{"id":"c","severity":"bogus","text":"x"},{"id":"d","severity":"warning","text":"ok","action":{"label":"x","page":"../evil"}}]}`))
		case "/api/vpn/summary/tasks":
			_, _ = w.Write([]byte(`{"items":[{"id":"scan","label":"Проверка серверов","value":318,"total":690,"cancel":"/api/elsewhere"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(worker.Close)
	dir := t.TempDir()
	t.Setenv("HOMENET_ACCESS_PATH", filepath.Join(dir, "access.json"))
	s, err := New(Config{StateDir: dir, StaticDir: dir, PackagesDir: dir, AccountURL: gate.URL, DMSURL: gate.URL}, "amd64")
	if err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(filepath.Join(dir, "credentials"), 0o700)
	_ = os.WriteFile(filepath.Join(dir, "credentials", "vpn.token"), []byte(strings.Repeat("k", 40)), 0o600)
	vpn := integration.Manifest{Schema: 1, ID: "vpn", Name: "VPN", Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 2, DataSchema: 1, Package: "homenet-vpn",
		UI: integration.UI{Entry: "entry.js", Pages: []integration.Page{{ID: "vpn", Title: "VPN"}},
			Widgets: []integration.Widget{
				{ID: "channel", Title: "Канал", Kind: "status", Sizes: []string{"s", "m"}, Data: "/api/vpn/widgets/channel", Refresh: 30, Modes: []string{"simple", "pro"}, Default: map[string]int{"simple": 1, "pro": 1}, Page: "vpn"},
				{ID: "traffic", Title: "Трафик", Kind: "stat", Sizes: []string{"s"}, Data: "/api/vpn/widgets/traffic", Refresh: 60, Modes: []string{"pro"}, Default: map[string]int{"pro": 2}},
				{ID: "huge", Title: "Большой", Kind: "stat", Sizes: []string{"m", "l"}, Data: "/api/vpn/widgets/huge", Modes: []string{"pro"}},
				{ID: "mine", Title: "Свой", Kind: "custom", Sizes: []string{"l"}, Modes: []string{"pro"}, Default: map[string]int{"pro": 3}},
			},
			Summary: &integration.Summary{Attention: "/api/vpn/summary/attention", Tasks: "/api/vpn/summary/tasks"}},
		Backend: integration.Backend{Endpoint: worker.URL, Health: "/health", Paths: []string{"/api/vpn/"}, Service: "S90vpn"}}
	old := integration.Manifest{Schema: 1, ID: "network", Name: "Связь", Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 1, DataSchema: 1, Package: "homenet-network",
		UI:      integration.UI{Entry: "entry.js", Pages: []integration.Page{{ID: "network", Title: "Связь"}}},
		Backend: integration.Backend{Endpoint: "http://127.0.0.1:1", Health: "/health", Paths: []string{"/api/network"}, Service: "S90network"}}
	if err := s.Registry.Replace([]integration.Installed{{Manifest: vpn, Enabled: true, Connection: "connected"}, {Manifest: old, Enabled: true, Connection: "connected"}}); err != nil {
		t.Fatal(err)
	}
	f.s = s
	return f
}

type homeReply struct {
	Customized bool                `json:"customized"`
	Layout     []LayoutItem        `json:"layout"`
	Catalog    []HomeWidget        `json:"catalog"`
	Data       map[string]HomeData `json:"data"`
	Attention  []HomeAttention     `json:"attention"`
	Tasks      []HomeTask          `json:"tasks"`
	Modules    []HomeModule        `json:"modules"`
}

func (f *homeFixture) get(t *testing.T, mode string) homeReply {
	t.Helper()
	w := httptest.NewRecorder()
	f.s.ServeHTTP(w, httptest.NewRequest("GET", "/api/platform/home?mode="+mode, nil))
	if w.Code != 200 {
		t.Fatalf("home: %d %s", w.Code, w.Body.String())
	}
	var r homeReply
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func (f *homeFixture) send(t *testing.T, method, body string) int {
	t.Helper()
	r := httptest.NewRequest(method, "http://example.com/api/platform/home/layout?mode=pro", strings.NewReader(body))
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-HomeNet-UI", "1")
	w := httptest.NewRecorder()
	f.s.ServeHTTP(w, r)
	return w.Code
}

func keys(l []LayoutItem) string {
	out := []string{}
	for _, i := range l {
		out = append(out, i.W+":"+i.Size)
	}
	return strings.Join(out, ",")
}

func TestHomeGathersWidgetsAttentionAndTasks(t *testing.T) {
	f := newHomeFixture(t)
	r := f.get(t, "pro")
	if keys(r.Layout) != "vpn/channel:s,vpn/traffic:s,vpn/mine:l" || r.Customized {
		t.Fatalf("default layout: %s", keys(r.Layout))
	}
	if d := r.Data["vpn/channel"]; d.State != "warn" || d.Note != "с 15:14" || !strings.Contains(string(d.Body), "Белые списки") || d.Stale {
		t.Fatalf("channel: %+v", d)
	}
	if _, ok := r.Data["vpn/huge"]; ok {
		t.Fatal("a widget not on the page was fetched")
	}
	if len(r.Attention) != 3 || r.Attention[0].ID != "b" || r.Attention[0].Action == nil || r.Attention[1].Action != nil || r.Attention[2].ID != "a" {
		t.Fatalf("attention: %+v", r.Attention)
	}
	if len(r.Tasks) != 1 || r.Tasks[0].Value != 318 || r.Tasks[0].Cancel != "" || r.Tasks[0].ModuleName != "VPN" {
		t.Fatalf("tasks: %+v", r.Tasks)
	}
	if len(r.Modules) != 2 || r.Modules[1].UIAPI != 1 || r.Modules[1].State != "ok" {
		t.Fatalf("modules: %+v", r.Modules)
	}
	simple := f.get(t, "simple")
	if keys(simple.Layout) != "vpn/channel:s" {
		t.Fatalf("simple layout: %s", keys(simple.Layout))
	}
	// answers are kept for their refresh time: a second page load asks nothing
	before := f.calls.Load()
	f.get(t, "pro")
	if f.calls.Load() != before {
		t.Fatalf("cached answers asked again: %d calls", f.calls.Load()-before)
	}
}

func TestHomeServesStaleDataWhenModuleIsSlow(t *testing.T) {
	f := newHomeFixture(t)
	old := homeModuleBudget
	homeModuleBudget = 150 * time.Millisecond
	t.Cleanup(func() { homeModuleBudget = old })
	f.get(t, "pro")
	// expire the cache, then make the module slow
	for _, e := range f.s.homeState().entries {
		e.ok = e.ok.Add(-time.Hour)
	}
	f.slow.Store(true)
	start := time.Now()
	r := f.get(t, "pro")
	if time.Since(start) > time.Second {
		t.Fatal("home waited for a slow module")
	}
	d := r.Data["vpn/channel"]
	if !d.Stale || d.State != "warn" || d.FetchedAt == nil || d.Error == "" {
		t.Fatalf("stale channel: %+v", d)
	}
	if r.Modules[0].State != "stale" || r.Attention[0].ID != "b" {
		t.Fatalf("modules %+v attention %+v", r.Modules, r.Attention)
	}
	found := false
	for _, a := range r.Attention {
		found = found || a.ID == "core-unreachable"
	}
	if !found || len(r.Tasks) != 0 {
		t.Fatalf("stale module must be reported and its tasks dropped: %+v %+v", r.Attention, r.Tasks)
	}
}

func TestHomeLayoutsPerUserAndMode(t *testing.T) {
	f := newHomeFixture(t)
	for _, bad := range []string{
		`{"mode":"pro","items":[{"w":"vpn/nope","size":"s"}]}`,
		`{"mode":"pro","items":[{"w":"vpn/traffic","size":"l"}]}`,
		`{"mode":"simple","items":[{"w":"vpn/traffic","size":"s"}]}`,
		`{"mode":"pro","items":[{"w":"vpn/channel","size":"s"},{"w":"vpn/channel","size":"m"}]}`,
		`{"mode":"x","items":[]}`,
		`{"mode":"pro"}`,
	} {
		if code := f.send(t, "PUT", bad); code != 400 {
			t.Fatalf("%s accepted: %d", bad, code)
		}
	}
	if code := f.send(t, "PUT", `{"mode":"pro","items":[{"w":"vpn/huge","size":"l"},{"w":"vpn/channel","size":"m"}]}`); code != 200 {
		t.Fatalf("save: %d", code)
	}
	r := f.get(t, "pro")
	if keys(r.Layout) != "vpn/huge:l,vpn/channel:m" || !r.Customized {
		t.Fatalf("saved layout: %s", keys(r.Layout))
	}
	if d := r.Data["vpn/huge"]; d.Error == "" || d.Body != nil {
		t.Fatalf("oversized answer must be an error: %+v", d)
	}
	if keys(f.get(t, "simple").Layout) != "vpn/channel:s" {
		t.Fatal("pro layout leaked into simple")
	}
	f.login.Store("bob")
	if r := f.get(t, "pro"); r.Customized {
		t.Fatal("bob sees alice's layout")
	}
	f.login.Store("../../etc/passwd")
	if code := f.send(t, "PUT", `{"mode":"pro","items":[]}`); code != 200 {
		t.Fatalf("odd login: %d", code)
	}
	if _, err := os.Stat(filepath.Join(f.s.Config.StateDir, "layouts")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(f.s.Config.StateDir, "layouts"))
	for _, e := range entries {
		if strings.Contains(e.Name(), "passwd") {
			t.Fatal("login used as a path")
		}
	}
	f.login.Store("alice")
	if code := f.send(t, "DELETE", ``); code != 200 {
		t.Fatalf("reset: %d", code)
	}
	if r := f.get(t, "pro"); r.Customized || keys(r.Layout) != "vpn/channel:s,vpn/traffic:s,vpn/mine:l" {
		t.Fatalf("reset layout: %s", keys(r.Layout))
	}
}

func TestHomeDisabledModuleShowsLastDataGrey(t *testing.T) {
	f := newHomeFixture(t)
	f.get(t, "pro")
	items := f.s.Registry.Snapshot()
	items[0].Enabled = false
	if err := f.s.Registry.Replace(items); err != nil {
		t.Fatal(err)
	}
	before := f.calls.Load()
	if code := f.send(t, "PUT", `{"mode":"pro","items":[{"w":"vpn/channel","size":"s"}]}`); code != 200 {
		t.Fatalf("layout with a disabled module's widget: %d", code)
	}
	r := f.get(t, "pro")
	d := r.Data["vpn/channel"]
	if d.Unavailable != "выключен" || !d.Stale || d.State != "warn" || f.calls.Load() != before {
		t.Fatalf("disabled: %+v, calls %d", d, f.calls.Load()-before)
	}
	if len(r.Catalog) != 0 {
		t.Fatal("a disabled module's widgets must leave the catalog")
	}
	// removed module: its widgets leave the layout silently
	if err := f.s.Registry.Replace(items[1:]); err != nil {
		t.Fatal(err)
	}
	if r := f.get(t, "pro"); len(r.Layout) != 0 {
		t.Fatalf("removed module stays: %s", keys(r.Layout))
	}
}

func TestHomeCoreTasksFromOperations(t *testing.T) {
	before := []integration.Installed{{Manifest: integration.Manifest{ID: "vpn", Version: "1.0.6"}}}
	tasks, attention := coreTasks([]integration.Operation{
		{ID: "op1", Status: "running", Step: "starting", Before: before, Changes: []integration.Change{{ID: "vpn", Action: "update", Version: "1.0.7"}}},
		{ID: "op2", Status: "recovery_required"},
	}, map[string]string{"vpn": "VPN"})
	if len(tasks) != 1 || tasks[0].Label != "Обновление «VPN» 1.0.6 → 1.0.7" || tasks[0].Value != 2 || tasks[0].Total != 4 {
		t.Fatalf("%+v", tasks)
	}
	if len(attention) != 1 || attention[0].Severity != "critical" {
		t.Fatalf("%+v", attention)
	}
}
