//go:build linux

package core

import (
	"fmt"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/schema"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationPreservesPathsAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "legacy")
	state := filepath.Join(root, "core")
	packages := filepath.Join(root, "packages")
	if err := os.MkdirAll(filepath.Join(legacy, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	routes := schema.DefaultRoutes()
	routes.Globals.UI.Port = 63412
	if err := schema.SaveRoutes(filepath.Join(legacy, "routes.yml"), routes); err != nil {
		t.Fatal(err)
	}
	env := []byte("LITE_UI_HOST=127.0.0.1\nLITE_UI_PORT=63412\n")
	if err := os.WriteFile(filepath.Join(legacy, "config", "runtime.env"), env, 0600); err != nil {
		t.Fatal(err)
	}
	for n, id := range []string{"proxy", "network", "vpn"} {
		dir := filepath.Join(packages, id, "1.0.0")
		if err := os.MkdirAll(filepath.Join(dir, "ui"), 0700); err != nil {
			t.Fatal(err)
		}
		m := integration.Manifest{Schema: 1, ID: id, Name: id, Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 1, DataSchema: 1, Package: "homenet-" + id, UI: integration.UI{Entry: "entry.js", Pages: []integration.Page{{ID: id, Title: id}}}, Backend: integration.Backend{Endpoint: fmt.Sprintf("http://127.0.0.1:%d", 63501+n), Health: "/health", Paths: []string{"/api/status"}, Service: "S90" + id}}
		if err := integration.AtomicJSON(filepath.Join(dir, "manifest.json"), m); err != nil {
			t.Fatal(err)
		}
		for _, file := range []string{"worker", "ui/entry.js"} {
			if err := os.WriteFile(filepath.Join(dir, file), []byte("fixture"), 0700); err != nil {
				t.Fatal(err)
			}
		}
	}
	in := MigrationInput{LegacyDir: legacy, StateDir: state, PackagesDir: packages, StaticDir: filepath.Join(root, "ui"), Version: "1.0.0", Arch: "amd64"}
	plan, err := PlanMigration(in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(state); !os.IsNotExist(err) {
		t.Fatal("planning wrote state")
	}
	for n := 0; n < 2; n++ {
		if err = PrepareMigration(plan); err != nil {
			t.Fatal(err)
		}
	}
	if plan.Config.Listen != "127.0.0.1:63412" || plan.Config.WorkerDefaults["ROUTES_PATH"] != filepath.Join(legacy, "routes.yml") {
		t.Fatal("legacy addresses or paths changed")
	}
	if b, _ := os.ReadFile(filepath.Join(legacy, "config", "runtime.env")); string(b) != string(env) {
		t.Fatal("runtime configuration overwritten")
	}
	if err := os.WriteFile(filepath.Join(state, "launcher-user-data"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = PrepareMigration(plan); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(state, "launcher-user-data")); string(b) != "preserve" {
		t.Fatal("rerun replaced Core state")
	}
}
