//go:build linux

package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestVPNDNSDurableRollbackAndForeignEdit(t *testing.T) {
	root := t.TempDir()
	hosts := filepath.Join(root, "hosts")
	config := filepath.Join(root, "config.yaml")
	original := []byte("127.0.0.1 localhost\n# keep user content\n")
	if err := os.WriteFile(hosts, original, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte(mihomoFixture), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOMENET_PLATFORM_STATE", root)
	t.Setenv("MIHOMO_CONFIG", config)
	t.Setenv("MIHOMO_DNS_MODE", "system-hosts")
	t.Setenv("MIHOMO_HOSTS_PATH", hosts)
	a := &app{}
	req := vpnDNSRequest{ID: "dns-test", Routes: mihomoTestRoutes()}
	tx, err := a.prepareDNSTransaction(req)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(hosts); !bytes.Equal(b, original) {
		t.Fatal("prepare changed live file")
	}
	if _, err = a.prepareDNSTransaction(vpnDNSRequest{ID: "dns-other", Routes: req.Routes}); err == nil {
		t.Fatal("concurrent DNS transaction accepted")
	}
	if _, err = a.transitionDNSTransaction(tx.ID, "apply"); err != nil {
		t.Fatal(err)
	}
	// A new manager instance reads the durable before image after a restart.
	if _, err = (&app{}).transitionDNSTransaction(tx.ID, "rollback"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(hosts); !bytes.Equal(b, original) {
		t.Fatal("rollback lost original bytes")
	}
	req.ID = "dns-test-two"
	if _, err = a.prepareDNSTransaction(req); err != nil {
		t.Fatal(err)
	}
	if _, err = a.transitionDNSTransaction(req.ID, "apply"); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("operator changed this file\n")
	if err = os.WriteFile(hosts, foreign, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = a.transitionDNSTransaction(req.ID, "rollback"); err == nil {
		t.Fatal("foreign edit overwritten")
	}
	if b, _ := os.ReadFile(hosts); !bytes.Equal(b, foreign) {
		t.Fatal("foreign edit not preserved")
	}
}

func TestVPNDNSReloadOnlyForChangedTransaction(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprint(changed), func(t *testing.T) {
			root := t.TempDir()
			target := filepath.Join(root, "config.yaml")
			before := []byte("secret: test\n")
			candidate := before
			if changed {
				candidate = []byte("secret: test\nhosts: {}\n")
			}
			// Simulate a crash after the rename, before the reload acknowledgement.
			if err := os.WriteFile(target, candidate, 0600); err != nil {
				t.Fatal(err)
			}
			reloads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "PUT" || r.URL.Path != "/configs" {
					t.Errorf("unexpected request")
				}
				reloads++
				w.WriteHeader(204)
			}))
			defer server.Close()
			t.Setenv("HOMENET_PLATFORM_STATE", root)
			t.Setenv("MIHOMO_CONFIG", target)
			t.Setenv("MIHOMO_BINARY", "/unused/mihomo")
			t.Setenv("MIHOMO_CONTROLLER", server.URL)
			t.Setenv("MIHOMO_SECRET", "test")
			t.Setenv("MIHOMO_DNS_MODE", "config-reload")
			tx := vpnDNSTransaction{ID: "dns-reload", Status: "applying", Mode: "config-reload", Target: target, FileMode: 0600, Before: before, Candidate: candidate}
			if err := saveDNSTransaction(tx); err != nil {
				t.Fatal(err)
			}
			a := &app{}
			if _, err := a.transitionDNSTransaction(tx.ID, "apply"); err != nil {
				t.Fatal(err)
			}
			if _, err := a.transitionDNSTransaction(tx.ID, "apply"); err != nil {
				t.Fatal(err)
			}
			if _, err := a.transitionDNSTransaction(tx.ID, "rollback"); err != nil {
				t.Fatal(err)
			}
			want := 0
			if changed {
				want = 2
			}
			if reloads != want {
				t.Fatalf("reloads=%d want %d", reloads, want)
			}
		})
	}
}

func TestVPNDNSPreviewDetectsRemovalAndNoop(t *testing.T) {
	root := t.TempDir()
	hosts := filepath.Join(root, "hosts")
	config := filepath.Join(root, "config.yaml")
	os.WriteFile(config, []byte(mihomoFixture), 0600)
	os.WriteFile(hosts, []byte("127.0.0.1 localhost\n"), 0644)
	t.Setenv("MIHOMO_CONFIG", config)
	t.Setenv("MIHOMO_DNS_MODE", "system-hosts")
	t.Setenv("MIHOMO_HOSTS_PATH", hosts)
	a := &app{}
	routes := mihomoTestRoutes()
	plan, err := a.previewMihomoDNS(routes)
	if err != nil || !plan.Changed {
		t.Fatalf("initial plan: %v", err)
	}
	settings, _, _ := mihomoEnvironment()
	candidate, _, err := a.mihomoSystemHostsCandidate(settings, routes)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(hosts, candidate, 0644)
	plan, err = a.previewMihomoDNS(routes)
	if err != nil || plan.Changed {
		t.Fatalf("no-op plan: %v", err)
	}
	routes.Hosts = nil
	plan, err = a.previewMihomoDNS(routes)
	if err != nil || !plan.Changed {
		t.Fatalf("removal plan: %v", err)
	}
}
