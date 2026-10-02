package main

import (
	"path/filepath"
	"testing"
	"time"
)

func conn(id, ip, host string, up, down int64, chains ...string) mihomoConn {
	c := mihomoConn{ID: id, Upload: up, Download: down, Chains: chains, Rule: "Match", Start: "2026-10-02T10:00:00Z"}
	c.Metadata.SourceIP = ip
	c.Metadata.Host = host
	c.Metadata.Network = "tcp"
	return c
}

func TestTrafficTotalsSurviveCoreRestart(t *testing.T) {
	tc := newTrafficCollector(filepath.Join(t.TempDir(), "traffic.json.gz"), time.Unix(1_800_000_000, 0))
	t0 := time.Unix(1_800_000_000, 0)
	tc.observe(t0, 100, 1000, nil)                    // baseline, nothing counted
	tc.observe(t0.Add(5*time.Second), 150, 1600, nil) // +50 / +600
	tc.observe(t0.Add(10*time.Second), 20, 300, nil)  // core restarted: counters from zero
	rep := tc.report("1h", t0.Add(20*time.Second))
	if rep["up"].(int64) != 70 || rep["down"].(int64) != 900 {
		t.Fatalf("totals %v / %v", rep["up"], rep["down"])
	}
}

func TestTrafficSplitByConnectionGrowthAndClosed(t *testing.T) {
	tc := newTrafficCollector(filepath.Join(t.TempDir(), "traffic.json.gz"), time.Unix(1_800_000_000, 0))
	t0 := time.Unix(1_800_000_000, 0)
	// A connection already open at start: only its growth from now on counts.
	tc.observe(t0.Add(-5*time.Second), 0, 0, []mihomoConn{conn("old", "192.168.1.9", "big.example.com", 5000, 900000, "DE-1", "PROXY")})
	tc.observe(t0, 0, 0, []mihomoConn{conn("a", "192.168.1.47", "rr3.googlevideo.com", 10, 100, "DE-1", "YouTube"), conn("old", "192.168.1.9", "big.example.com", 5000, 900010, "DE-1", "PROXY")})
	tc.observe(t0.Add(5*time.Second), 0, 0, []mihomoConn{
		conn("a", "192.168.1.47", "rr3.googlevideo.com", 15, 400, "DE-1", "YouTube"),
		conn("b", "192.168.1.23", "api.telegram.org", 1, 2, "FI", "Telegram"),
	})
	tc.observe(t0.Add(10*time.Second), 0, 0, []mihomoConn{conn("b", "192.168.1.23", "api.telegram.org", 1, 2, "FI", "Telegram")})

	rep := tc.report("24h", t0.Add(20*time.Second))
	dims := rep["dims"].(map[string][]dimRow)
	var yt dimRow
	for _, r := range dims["site"] {
		if r.Key == "googlevideo.com" {
			yt = r
		}
	}
	if yt.Down != 400 || yt.Up != 15 || yt.Count != 1 {
		t.Fatalf("site split wrong: %+v", yt)
	}
	for _, r := range dims["site"] {
		if r.Key == "example.com" && r.Down != 10 {
			t.Fatalf("pre-existing connection counted its past: %+v", r)
		}
	}
	if dims["outbound"][0].Key != "DE-1" || dims["device"][0].Key != "192.168.1.47" {
		t.Fatalf("unexpected order %+v %+v", dims["outbound"], dims["device"])
	}
	closed := rep["closed"].([]closedConn)
	if len(closed) != 2 || closed[0].Host != "rr3.googlevideo.com" || closed[0].Down != 400 {
		t.Fatalf("closed %+v", closed)
	}
}

func TestTrafficStatePersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic.json.gz")
	t0 := time.Unix(1_800_000_000, 0)
	tc := newTrafficCollector(path, t0)
	tc.observe(t0, 0, 0, nil)
	tc.observe(t0.Add(5*time.Second), 10, 20, nil)
	tc.save()
	again := newTrafficCollector(path, t0.Add(time.Hour))
	rep := again.report("24h", t0.Add(time.Minute))
	if rep["down"].(int64) != 20 || rep["since"].(int64) != t0.Unix() {
		t.Fatalf("state not restored: %v", rep)
	}
}

func TestSiteOf(t *testing.T) {
	for in, want := range map[string]string{
		"rr3.googlevideo.com": "googlevideo.com",
		"www.bbc.co.uk":       "bbc.co.uk",
		"ya.ru":               "ya.ru",
		"173.194.18.72":       "173.194.18.72",
	} {
		if got := siteOf(in); got != want {
			t.Errorf("siteOf(%q) = %q, want %q", in, got, want)
		}
	}
}
