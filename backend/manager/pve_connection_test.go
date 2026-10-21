package main

import (
	"testing"
	"time"
)

func TestPVEConnectionStatus(t *testing.T) {
	oldKind, oldPVE := moduleKind, pvh
	t.Cleanup(func() { moduleKind, pvh = oldKind, oldPVE })
	moduleKind, pvh = "pve", nil
	a := &app{}
	if got := a.moduleConnection(); got != "unconfigured" {
		t.Fatalf("unconfigured: %s", got)
	}
	pvh = pvhTestMonitor(t, time.Now().Unix())
	if got := a.moduleConnection(); got != "connected" {
		t.Fatalf("fresh host: %s", got)
	}
	pvh.hosts[0].Parsed.TS -= 120
	if got := a.moduleConnection(); got != "unavailable" {
		t.Fatalf("stale host: %s", got)
	}
	pvh.hosts = nil
	pvh.loadErr = "invalid configuration"
	if got := a.moduleConnection(); got != "unavailable" {
		t.Fatalf("invalid configuration: %s", got)
	}
}
