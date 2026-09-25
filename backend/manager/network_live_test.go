package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// NET_LIVE=1 NET_TARGETS=a.com,b.com runs the analyzer on the router itself.
func TestAnalyzerLive(t *testing.T) {
	if os.Getenv("NET_LIVE") != "1" {
		t.Skip("NET_LIVE=1 to probe real targets from the router")
	}
	for _, target := range strings.Split(getenv("NET_TARGETS", "youtube.com"), ",") {
		res, err := analyze(target, nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.MarshalIndent(res, "", "  ")
		t.Logf("%s", body)
	}
}

// LTE_SURVEY=7 runs a band survey on the real modem (drops the internet for
// about a minute) and checks that the band setting is restored.
func TestLTESurveyLive(t *testing.T) {
	raw := os.Getenv("LTE_SURVEY")
	if raw == "" {
		t.Skip("LTE_SURVEY=<bands> to lock the real modem band by band")
	}
	var bands []int
	for _, b := range strings.Split(raw, ",") {
		n := 0
		for _, ch := range b {
			n = n*10 + int(ch-'0')
		}
		bands = append(bands, n)
	}
	s, err := lteTool.startSurvey(bands, "live test")
	if err != nil {
		t.Fatal(err)
	}
	for {
		lteTool.mu.Lock()
		busy := lteTool.busy
		lteTool.mu.Unlock()
		if !busy {
			break
		}
		time.Sleep(time.Second)
	}
	body, _ := json.MarshalIndent(lteTool.history[0], "", "  ")
	t.Logf("%s", body)
	if !lteTool.history[0].Restored {
		t.Fatalf("band setting not restored: %+v", s)
	}
}
