//go:build linux

package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuardedCutoverAndRollback(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "guard-failure"}[fail], func(t *testing.T) {
			root := t.TempDir()
			release := filepath.Join(root, "release")
			bin := filepath.Join(root, "bin")
			init := filepath.Join(root, "init")
			for _, p := range []string{release, bin, init} {
				if err := os.MkdirAll(p, 0700); err != nil {
					t.Fatal(err)
				}
			}
			write := func(file, body string) {
				t.Helper()
				if err := os.WriteFile(file, []byte(body), 0700); err != nil {
					t.Fatal(err)
				}
			}
			trace := filepath.Join(root, "trace")
			write(filepath.Join(release, "core"), "#!/bin/sh\nexit 0\n")
			write(filepath.Join(release, "platformctl"), "#!/bin/sh\n[ \"$1\" != ready-url ] || echo http://127.0.0.1:1/health/ready\nexit 0\n")
			write(filepath.Join(release, "S99homenet-core"), "#!/bin/sh\necho core-$1 >> \"$TEST_TRACE\"\n")
			legacy := filepath.Join(init, "S99legacy")
			write(legacy, "#!/bin/sh\necho legacy-$1 >> \"$TEST_TRACE\"\n")
			write(filepath.Join(bin, "curl"), "#!/bin/sh\nexit ${TEST_FAIL_READY:-0}\n")
			write(filepath.Join(bin, "sleep"), "#!/bin/sh\nexit 0\n")
			cfg := filepath.Join(root, "config.json")
			write(cfg, "{}")
			t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
			t.Setenv("TEST_TRACE", trace)
			if fail {
				t.Setenv("TEST_FAIL_READY", "1")
			}
			t.Setenv("HOMENET_CORE_CONFIG", cfg)
			t.Setenv("HOMENET_CORE_CURRENT", filepath.Join(root, "current"))
			t.Setenv("HOMENET_CORE_INIT", filepath.Join(init, "S99core"))
			t.Setenv("HOMENET_LEGACY_INIT", legacy)
			script, err := filepath.Abs("../../../scripts/activate-modular.sh")
			if err != nil {
				t.Fatal(err)
			}
			output, err := exec.Command("sh", script, release, "--dry-run").CombinedOutput()
			if err != nil {
				t.Fatalf("dry-run: %v %s", err, output)
			}
			if _, err = os.Stat(trace); !os.IsNotExist(err) {
				t.Fatal("dry-run touched a service")
			}
			output, err = exec.Command("sh", script, release, "--apply").CombinedOutput()
			if fail && err == nil || !fail && err != nil {
				t.Fatalf("apply: %v %s", err, output)
			}
			if !fail {
				if _, err = os.Lstat(legacy); !os.IsNotExist(err) {
					t.Fatal("legacy autostart left enabled")
				}
				output, err = exec.Command("sh", script, release, "--rollback").CombinedOutput()
				if err != nil {
					t.Fatalf("rollback: %v %s", err, output)
				}
			}
			if _, err = os.Stat(legacy); err != nil {
				t.Fatal("legacy service not restored")
			}
			body, err := os.ReadFile(trace)
			if err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(string(body)) != "legacy-stop\ncore-start\ncore-stop\nlegacy-start" {
				t.Fatalf("unsafe service order: %s", body)
			}
		})
	}
}
