package core

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amagomedsharipov/nginx-proxy-manager/backend/internal/integration"
)

type lifecycleRuntime struct{ starts, stops int }

func (f *lifecycleRuntime) Start(context.Context, integration.Manifest) error { f.starts++; return nil }
func (f *lifecycleRuntime) Stop(context.Context, integration.Manifest) error  { f.stops++; return nil }
func (f *lifecycleRuntime) Check(context.Context, integration.Manifest) error { return nil }

func TestLifecycleAPIPlanApplyReplayAndDisable(t *testing.T) {
	s := testServer(t, "admin", 204)
	s.Config.ManageWorkers = true
	fake := &lifecycleRuntime{}
	s.Lifecycle.Runtime = fake
	m := integration.Manifest{Schema: 1, ID: "vpn", Name: "VPN", Version: "1.0.0", Arch: "amd64", CoreAPI: 1, UIAPI: 1, DataSchema: 1, Package: "homenet-vpn", UI: integration.UI{Entry: "entry.js", Pages: []integration.Page{{ID: "vpn", Title: "VPN"}}}, Backend: integration.Backend{Endpoint: "http://127.0.0.1:18371", Health: "/health", Paths: []string{"/api/core"}, Service: "S90vpn"}}
	dir := filepath.Join(s.Config.PackagesDir, "vpn", "1.0.0")
	os.MkdirAll(filepath.Join(dir, "ui"), 0700)
	if err := integration.AtomicJSON(filepath.Join(dir, "manifest.json"), m); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "worker"), []byte("test worker"), 0700)
	os.WriteFile(filepath.Join(dir, "ui", "entry.js"), []byte("export {}"), 0600)
	post := func(path, body string, status int) []byte {
		t.Helper()
		r := httptest.NewRequest("POST", "http://core.test"+path, strings.NewReader(body))
		r.Header.Set("Origin", "http://core.test")
		r.Header.Set("X-HomeNet-UI", "1")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	for _, action := range []string{"install", "disable"} {
		body := post("/api/platform/plan", fmt.Sprintf(`{"changes":[{"id":"vpn","action":%q,"version":"1.0.0"}]}`, action), 200)
		var op integration.Operation
		if err := json.Unmarshal(body, &op); err != nil {
			t.Fatal(err)
		}
		for n := 0; n < 2; n++ {
			post("/api/platform/apply", fmt.Sprintf(`{"id":%q}`, op.ID), 202)
			s.WaitOperations()
		}
		finished, err := s.Lifecycle.Operation(op.ID)
		if err != nil || finished.Status != "succeeded" {
			t.Fatalf("operation failed: %+v %v", finished, err)
		}
	}
	if fake.starts != 1 || fake.stops != 1 || s.Registry.Snapshot()[0].Enabled {
		t.Fatal("replay changed process state twice")
	}
}
