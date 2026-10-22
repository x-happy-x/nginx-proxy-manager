package launcher

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
)

// NPM-83: the repository link survives a save and must be an http(s) address.
func TestSaveKeepsRepo(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "launcher.json")}
	cfg := Config{
		Devices: []Device{{ID: "s3", Name: "Сервер S3", Kind: "server"}},
		Links:   []Link{{ID: "p3d", Title: "P3D", URL: "https://p3d.example/", Device: "s3", Repo: "https://git.example/services/p3d"}},
		Apps:    map[string]AppOverride{"bigfam": {Repo: "https://git.example/services/bigfam"}},
	}
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Links[0].Repo != cfg.Links[0].Repo || loaded.Apps["bigfam"].Repo != cfg.Apps["bigfam"].Repo {
		t.Fatalf("repo lost: %+v", loaded)
	}

	cfg.Apps["bigfam"] = AppOverride{Repo: "javascript:alert(1)"}
	if err := store.Save(cfg); err == nil {
		t.Fatal("non-http repo accepted")
	}
}

// NPM-84: upstream is a private host:port, like a probe target.
func TestSaveChecksUpstream(t *testing.T) {
	store := Store{Path: filepath.Join(t.TempDir(), "launcher.json")}
	cfg := Config{Links: []Link{{ID: "p3d", Title: "P3D", URL: "https://p3d.example/", Upstream: "192.168.99.33:4191"}}, Dismissed: []string{"192.168.99.33:18401"}}
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	if loaded, _ := store.Load(); loaded.Links[0].Upstream != "192.168.99.33:4191" || loaded.Dismissed[0] != "192.168.99.33:18401" {
		t.Fatalf("lost: %+v", loaded)
	}
	cfg.Links[0].Upstream = "8.8.8.8:53"
	if err := store.Save(cfg); err == nil {
		t.Fatal("public upstream accepted")
	}
}

// NPM-86: the start of the current state is kept; a change seen between two checks is exact.
func TestRememberKeepsStateStart(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	key := "192.0.2.10:80"
	if p := remember(key, Probe{OK: true}, t0); p.Since != t0.Unix() || p.Exact {
		t.Fatalf("first check: %+v", p)
	}
	if p := remember(key, Probe{OK: true}, t0.Add(time.Minute)); p.Since != t0.Unix() {
		t.Fatalf("unchanged state moved: %+v", p)
	}
	down := t0.Add(2 * time.Minute)
	if p := remember(key, Probe{OK: false}, down); p.Since != down.Unix() || !p.Exact {
		t.Fatalf("change: %+v", p)
	}
	if p := remember(key, Probe{OK: false}, down.Add(10*time.Minute)); p.Since != down.Unix() || !p.Exact {
		t.Fatalf("still down: %+v", p)
	}
}

func TestTargetsFollowThePortal(t *testing.T) {
	var app schema.App
	app.Upstream.Address, app.Upstream.Port = "192.168.99.33", 4161
	cfg := &Config{Links: []Link{{URL: "https://p3d.example/", Upstream: "192.168.99.33:4191"}, {URL: "http://192.168.99.11/"}, {URL: "https://task.example/"}}}
	got := Targets([]schema.App{app}, cfg)
	want := []string{"192.168.99.33:4161", "192.168.99.33:4191", "192.168.99.11:80", "task.example:443"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v", got)
	}
}
