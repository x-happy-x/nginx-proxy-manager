package main

import (
	"strings"
	"testing"
)

func TestListenerStatusOnlyIncludesOwnedPIDs(t *testing.T) {
	output := strings.Join([]string{
		`tcp 0 0 192.168.1.1:443 0.0.0.0:* LISTEN 838/null`,
		`tcp 0 0 192.168.1.2:80 0.0.0.0:* LISTEN 1234/nginx`,
		`tcp 0 0 192.168.1.2:443 0.0.0.0:* LISTEN 1234/proxy.conf`,
		`tcp 0 0 192.168.1.2:8080 0.0.0.0:* LISTEN 12345/nginx`,
		`LISTEN 0 128 192.168.1.2:24492 0.0.0.0:* users:(("nginx",pid=1234,fd=8))`,
		`LISTEN 0 128 192.168.1.1:8081 0.0.0.0:* users:(("nginx",pid=838,fd=9))`,
		`LISTEN 0 128 192.168.1.2:24493 0.0.0.0:* users:(("nginx",pid=12345,fd=8))`,
	}, "\n")
	for _, pids := range [][]string{nil, {}, {"invalid"}, {"1"}} {
		if got := filterNginxListeners(output, pids); len(got) != 0 {
			t.Fatalf("unverified PIDs exposed unrelated listeners: %v", got)
		}
	}
	got := filterNginxListeners(output, []string{"1234"})
	if len(got) != 3 || !strings.Contains(got[1], "proxy.conf") {
		t.Fatalf("dedicated listeners incorrectly filtered: %v", got)
	}
	for _, line := range got {
		if strings.Contains(line, "12345") || strings.Contains(line, "838/") {
			t.Fatal("unrelated process listener included")
		}
	}
}
