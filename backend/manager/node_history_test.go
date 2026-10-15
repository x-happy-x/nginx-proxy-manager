package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// NPM-71: each node's checks and its week by hour, kept across restarts.
func TestNodeHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "h.json.gz")
	h := newNodeHistory(path)
	base := time.Date(2026, 10, 15, 6, 0, 0, 0, time.UTC)
	snap := func(at time.Time, ok bool, fail string) map[string]providerSnapshot {
		r := adaptiveResult{OK: ok, At: at, Probes: []adaptiveProbe{{OK: ok, MS: 431, Fail: fail}}}
		return map[string]providerSnapshot{"ROUTER": {Adaptive: &adaptiveSnapshot{Results: map[string]adaptiveResult{"A": r, "skip": {Skipped: "mode", At: at}}}}}
	}
	h.observe(base, snap(base.Add(5*time.Minute), true, ""))
	h.observe(base, snap(base.Add(5*time.Minute), true, "")) // the same probe twice is one check
	h.observe(base, snap(base.Add(30*time.Minute), false, "silent"))
	h.observe(base, snap(base.Add(2*time.Hour), false, "tls"))
	if got := h.strip("ROUTER", "A", 24); got != "ost" {
		t.Fatalf("strip %q", got)
	}
	if h.strip("ROUTER", "skip", 24) != "" {
		t.Fatal("a skipped node was recorded")
	}
	d, ok := h.detail("ROUTER", "A", base.Add(2*time.Hour))
	if !ok || len(d.Week) != nodeWeekHours || !strings.HasSuffix(d.Week, "y.r") || d.Checks[0].MS != 431 {
		t.Fatalf("week %q checks %+v", d.Week[len(d.Week)-5:], d.Checks)
	}
	// the week moves with the clock; checks over 48 fall off
	for i := 0; i < 60; i++ {
		h.observe(base, snap(base.Add(time.Duration(3*60+i)*time.Minute), true, ""))
	}
	if d, _ := h.detail("ROUTER", "A", base.Add(30*time.Hour)); len(d.Checks) != nodeChecksKeep || !strings.HasSuffix(d.Week, strings.Repeat(".", 26)) {
		t.Fatalf("after a day: %d checks, week end %q", len(d.Checks), d.Week[len(d.Week)-30:])
	}
	h.save(true)
	again := newNodeHistory(path)
	if again.strip("ROUTER", "A", 3) != "ooo" {
		t.Fatal("history lost on restart")
	}
	// a node unchecked for a week is forgotten
	again.observe(base.Add(9*24*time.Hour), map[string]providerSnapshot{"ROUTER": {Adaptive: &adaptiveSnapshot{Results: map[string]adaptiveResult{"B": {OK: true, At: base.Add(9 * 24 * time.Hour)}}}}})
	if again.strip("ROUTER", "A", 3) != "" || again.strip("ROUTER", "B", 3) != "o" {
		t.Fatal("old node kept")
	}
}
