package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLauncherTargetOnlyLocalNetwork(t *testing.T) {
	cases := map[string]bool{
		"192.168.1.1:9109":     true,
		"127.0.0.1:18080":      true,
		"10.0.0.5:22":          true,
		"xkeen-net.local:80":   true,
		"8.8.8.8:53":           false,
		"example.com:443":      false,
		"192.168.1.1":          false,
		"task.crubs.store:443": false,
	}
	for input, want := range cases {
		if _, ok := launcherTarget(input); ok != want {
			t.Errorf("launcherTarget(%q) = %v, want %v", input, ok, want)
		}
	}
}

func TestLauncherSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	a := &app{activeRoutesPath: filepath.Join(dir, "routes.yml")}
	if cfg, err := a.loadLauncher(); err != nil || cfg != nil {
		t.Fatalf("empty dir: cfg=%v err=%v", cfg, err)
	}
	bad := launcherConfig{Links: []launcherLink{{ID: "x", Title: "X", URL: "javascript:alert(1)"}}}
	if err := a.saveLauncher(bad); err == nil {
		t.Fatal("non-http link accepted")
	}
	good := launcherConfig{
		Devices: []launcherDevice{{ID: "pc-x", Name: "PC-X", Kind: "pc", Addresses: []string{"192.168.1.10"}}},
		Links:   []launcherLink{{ID: "t", Title: "Трекер", URL: "https://task.example/", Device: "pc-x"}},
	}
	if err := a.saveLauncher(good); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "launcher.json")); err != nil {
		t.Fatal("launcher.json not written next to routes.yml")
	}
	loaded, err := a.loadLauncher()
	if err != nil || loaded == nil || loaded.Devices[0].Name != "PC-X" || loaded.Links[0].Title != "Трекер" {
		t.Fatalf("round trip failed: %+v %v", loaded, err)
	}
}
