package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOlcRelayCommandIsShell(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	for _, arch := range []string{"amd64", "arm64", "mips"} {
		// a file, not -c: Windows quoting of a long multi-line argument is not the point here
		file := filepath.Join(t.TempDir(), "relay.sh")
		if err := os.WriteFile(file, []byte(olcRelayCommand(arch)), 0o644); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(sh, "-n", file).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v %s", arch, err, out)
		}
	}
	if c := olcRelayCommand("amd64"); !strings.Contains(c, "mihomo-linux-amd64-v1-$v.gz") || !strings.Contains(c, "homenet_olcrtc") {
		t.Fatal("release name or guard missing")
	}
	if m := olcRelayOut.FindStringSubmatch("guard: on\nRELAY 18443 abcDEF123\n"); m == nil || m[1] != "18443" || m[2] != "abcDEF123" {
		t.Fatalf("relay output not parsed: %v", m)
	}
}

func TestOlcNodeGetsRelay(t *testing.T) {
	srv := &olcServer{Key: "k"}
	if n := olcNodeConfig(srv, olcVariant{Node: "n"}); n["udp-relay"] != nil {
		t.Fatal("relay option without a relay")
	}
	srv.UDPPort, srv.UDPKey = 18443, "secret"
	r, _ := olcNodeConfig(srv, olcVariant{Node: "n"})["udp-relay"].(map[string]any)
	if r["port"] != 18443 || r["password"] != "secret" || r["server"] != "127.0.0.1" {
		t.Fatalf("relay option %v", r)
	}
}
