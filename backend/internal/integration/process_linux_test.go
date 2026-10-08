//go:build linux

package integration

import (
	"context"
	"encoding/json"
	"flag"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("HOMENET_TEST_WORKER") == "1" {
		fs := flag.NewFlagSet("worker", flag.ExitOnError)
		manifest := fs.String("manifest", "", "")
		token := fs.String("token-file", "", "")
		_ = fs.Parse(os.Args[1:])
		b, err := os.ReadFile(*manifest)
		if err != nil {
			os.Exit(2)
		}
		var pkg Manifest
		if json.Unmarshal(b, &pkg) != nil {
			os.Exit(2)
		}
		credential, err := os.ReadFile(*token)
		if err != nil {
			os.Exit(2)
		}
		handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+strings.TrimSpace(string(credential)) {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "integration": pkg.ID, "version": pkg.Version})
		})
		_ = http.ListenAndServe(strings.TrimPrefix(pkg.Backend.Endpoint, "http://"), handler)
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func TestRealProcessAdoptionAndStopIdentity(t *testing.T) {
	t.Setenv("HOMENET_TEST_WORKER", "1")
	l, _ := lifecycleFixture(t)
	pkg, err := l.Candidate("vpn", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	pkg.Backend.Endpoint = "http://" + listener.Addr().String()
	listener.Close()
	root := filepath.Join(l.PackagesDir, pkg.ID, pkg.Version)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "worker"), binary, 0700); err != nil {
		t.Fatal(err)
	}
	if err = AtomicJSON(filepath.Join(root, "manifest.json"), pkg); err != nil {
		t.Fatal(err)
	}
	runtime := &Processes{StateDir: l.StateDir, PackagesDir: l.PackagesDir}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err = runtime.Start(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = runtime.Stop(cleanup, pkg)
	})
	if err = runtime.Check(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	first, alive, err := runtime.record(pkg)
	if err != nil || !alive {
		t.Fatalf("worker not recorded: %v", err)
	}
	adopted := &Processes{StateDir: l.StateDir, PackagesDir: l.PackagesDir}
	if err = adopted.Start(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	second, alive, err := adopted.record(pkg)
	if err != nil || !alive || first.PID != second.PID {
		t.Fatal("restart spawned duplicate worker")
	}
	wrong := pkg
	wrong.Version = "1.1.0"
	if err = adopted.Stop(ctx, wrong); err != nil {
		t.Fatal(err)
	}
	if err = runtime.Check(ctx, pkg); err != nil {
		t.Fatal("rollback stopped previous version")
	}
	if err = adopted.Stop(ctx, pkg); err != nil {
		t.Fatal(err)
	}
	if _, alive, err = runtime.record(pkg); err != nil || alive {
		t.Fatal("worker remained alive")
	}
	unlock, err := LockState(l.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if release, err := LockState(l.StateDir); err == nil {
		release()
		t.Fatal("two coordinators acquired state")
	}
}
