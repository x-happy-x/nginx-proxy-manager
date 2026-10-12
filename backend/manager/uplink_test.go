package main

import (
	"testing"
	"time"
)

// A subscription removed from the core keeps its history but must not stand
// for the present, and the mode comes from the channel, not a subscription.
func TestHealthReportUsesChannelAndFreshSubscription(t *testing.T) {
	tc := &trafficCollector{live: map[string]liveConn{}}
	t0 := time.Unix(1_800_000_000, 0).Truncate(time.Hour)
	big := providerSnapshot{Proxies: make([]proxySnapshot, 300), Adaptive: &adaptiveSnapshot{Mode: "unknown"}}
	router := providerSnapshot{Proxies: make([]proxySnapshot, 151), Adaptive: &adaptiveSnapshot{Mode: "whitelist"}}
	// «AI» was big and is gone since t0
	tc.observeHealth(t0, map[string]providerSnapshot{"AI": big, "ROUTER": router})
	for i := 1; i <= 30; i++ {
		now := t0.Add(time.Duration(i) * time.Minute)
		tc.observeHealth(now, map[string]providerSnapshot{"ROUTER": router})
		tc.observeUplink(now, "whitelist")
	}
	rep := tc.healthReport("", "24h", t0.Add(31*time.Minute))
	if rep["provider"] != "ROUTER" {
		t.Fatalf("stale subscription chosen: %v", rep["provider"])
	}
	series := rep["series"].([]healthPoint)
	last := series[len(series)-1]
	if last.Whitelist != 1 || last.Unknown != 0 || rep["uplink"] != true {
		t.Fatalf("last point %+v uplink %v", last, rep["uplink"])
	}
	// a subscription's own «unknown» is replaced by the channel's mode
	rep = tc.healthReport("AI", "24h", t0.Add(31*time.Minute))
	if s := rep["series"].([]healthPoint); len(s) != 1 || s[0].Unknown != 1 {
		t.Fatalf("AI before the channel history: %+v", s)
	}
	tc.observeUplink(t0, "whitelist") // older minute: ignored, history is in order
	if n := len(tc.st.Uplink.Minutes); n != 30 {
		t.Fatalf("uplink minutes %d", n)
	}
}

func TestHealthReportFallsBackToChannelHistory(t *testing.T) {
	tc := &trafficCollector{live: map[string]liveConn{}}
	t0 := time.Unix(1_800_000_000, 0).Truncate(time.Hour)
	tc.observeUplink(t0, "normal")
	tc.observeUplink(t0.Add(time.Minute), "whitelist")
	rep := tc.healthReport("", "24h", t0.Add(2*time.Minute))
	s := rep["series"].([]healthPoint)
	if len(s) != 2 || s[1].Whitelist != 1 || rep["uplink"] != true {
		t.Fatalf("no subscriptions: series %+v", s)
	}
}
