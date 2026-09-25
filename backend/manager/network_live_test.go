package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
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
