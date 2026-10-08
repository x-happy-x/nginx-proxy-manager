package integration

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

type fakeRuntime struct {
	running map[string]string
	fail    string
	stops   int
}

func (f *fakeRuntime) Start(_ context.Context, m Manifest) error {
	f.running[m.ID] = m.Version
	return nil
}
func (f *fakeRuntime) Stop(_ context.Context, m Manifest) error {
	delete(f.running, m.ID)
	f.stops++
	return nil
}
func (f *fakeRuntime) Check(_ context.Context, m Manifest) error {
	if m.Version == f.fail {
		return fmt.Errorf("readiness failure")
	}
	return nil
}
func lifecycleFixture(t *testing.T) (*Lifecycle, *fakeRuntime) {
	t.Helper()
	dir := t.TempDir()
	r, err := Open(filepath.Join(dir, "registry.json"), "amd64")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRuntime{running: map[string]string{}}
	l := &Lifecycle{Registry: r, Runtime: f, PackagesDir: filepath.Join(dir, "packages"), StateDir: dir, Arch: "amd64"}
	for _, id := range []string{"proxy", "network", "vpn"} {
		for _, v := range []string{"1.0.0", "1.1.0"} {
			m := fixture(id)
			m.Version = v
			root := filepath.Join(l.PackagesDir, id, v)
			if err := os.MkdirAll(filepath.Join(root, "ui"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := AtomicJSON(filepath.Join(root, "manifest.json"), m); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"worker", "nginx", "ui/entry.js"} {
				if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0700); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	return l, f
}
func TestReleaseSetAtomicRollbackAndRecovery(t *testing.T) {
	l, f := lifecycleFixture(t)
	ctx := context.Background()
	changes := []Change{}
	for _, id := range []string{"proxy", "network", "vpn"} {
		changes = append(changes, Change{id, "install", "1.0.0"})
	}
	op, err := l.Plan(changes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = l.Apply(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if len(f.running) != 3 {
		t.Fatal("set did not start")
	}
	f.fail = "1.1.0"
	op, err = l.Plan([]Change{{"vpn", "update", "1.1.0"}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := l.Apply(ctx, op.ID)
	if err == nil || result.Status != "rolled_back" || f.running["vpn"] != "1.0.0" {
		t.Fatalf("failed candidate not rolled back: %+v %v", result, err)
	}
	// Simulate power loss after the new process starts but before registry commit.
	op, err = l.Plan([]Change{{"vpn", "update", "1.1.0"}})
	if err != nil {
		t.Fatal(err)
	}
	op.Status = "running"
	op.Step = "committing"
	if err = l.save(op); err != nil {
		t.Fatal(err)
	}
	f.running["vpn"] = "1.1.0"
	if err = l.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	if f.running["vpn"] != "1.0.0" {
		t.Fatal("restart did not restore old set")
	}
}
func TestDisableRemovePreserveDataAndIdempotency(t *testing.T) {
	l, f := lifecycleFixture(t)
	ctx := context.Background()
	data := filepath.Join(l.StateDir, "user-history")
	if err := os.WriteFile(data, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"install", "disable", "enable", "remove"} {
		op, err := l.Plan([]Change{{"vpn", action, "1.0.0"}})
		if err != nil {
			t.Fatal(err)
		}
		result, err := l.Apply(ctx, op.ID)
		if err != nil || result.Status != "succeeded" {
			t.Fatal(err)
		}
		stops := f.stops
		if _, err = l.Apply(ctx, op.ID); err != nil || stops != f.stops {
			t.Fatal("replayed operation mutated state")
		}
	}
	if b, err := os.ReadFile(data); err != nil || string(b) != "keep" {
		t.Fatal("user data lost")
	}
	if len(l.Registry.Snapshot()) != 0 || len(f.running) != 0 {
		t.Fatal("removal left active integration")
	}
}
func TestStalePlanAndDataMigrationRejected(t *testing.T) {
	l, _ := lifecycleFixture(t)
	ctx := context.Background()
	old, _ := l.Plan([]Change{{"vpn", "install", "1.0.0"}})
	other, _ := l.Plan([]Change{{"proxy", "install", "1.0.0"}})
	if _, err := l.Apply(ctx, other.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Apply(ctx, old.ID); err == nil {
		t.Fatal("stale plan accepted")
	}
	m := fixture("proxy")
	m.Version = "1.1.0"
	m.DataSchema = 2
	if err := AtomicJSON(filepath.Join(l.PackagesDir, "proxy", "1.1.0", "manifest.json"), m); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Plan([]Change{{"proxy", "update", "1.1.0"}}); err == nil {
		t.Fatal("implicit data migration accepted")
	}
}
