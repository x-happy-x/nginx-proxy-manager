//go:build linux

package main

import (
	"bytes"
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
