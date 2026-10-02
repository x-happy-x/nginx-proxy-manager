package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreBackups(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "config.yaml")
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("config.yaml", "mode: rule\n")
	write(".homenet-backup-20261002.yaml", "secret: hunter2\nmode: rule\n")
	write("config.yaml.bak-groups", "mode: global\n")
	write(".homenet-staged-1.yaml", "mode: rule\n")
	write("other.yaml", "mode: rule\n")

	list := listCoreBackups(target)
	names := []string{}
	for _, b := range list {
		names = append(names, b.Name+":"+b.Kind)
	}
	got := strings.Join(names, ",")
	if !strings.Contains(got, ".homenet-backup-20261002.yaml:auto") || !strings.Contains(got, "config.yaml.bak-groups:manual") || strings.Contains(got, "staged") || strings.Contains(got, "other.yaml") || len(list) != 2 {
		t.Fatalf("backups = %s", got)
	}

	body, err := readCoreBackup(target, ".homenet-backup-20261002.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "hunter2") {
		t.Errorf("secret not masked:\n%s", body)
	}
	for _, bad := range []string{"other.yaml", "../config.yaml", ".homenet-staged-1.yaml", ""} {
		if _, err := readCoreBackup(target, bad); err == nil {
			t.Errorf("read of %q allowed", bad)
		}
	}
}
