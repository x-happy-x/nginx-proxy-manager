package main

import (
	"regexp"
	"testing"
	"time"
)

func TestRouteClass(t *testing.T) {
	c := routeClassifier{bypass: regexp.MustCompile(wordsRE(defaultRouting().Bypass))}
	cases := map[string]string{
		"DIRECT":         routeDirect,
		"REJECT":         "",
		"":               "",
		"⛓ 🇳🇱 Амстердам": routeChain,
		"🇫🇮 LTE #1":      routeBypass,
		"🇫🇲 ОБХОД №2-1":  routeBypass,
		"ИИ | 🇩🇪 Germany, Extra Whitelist": routeBypass,
		"🇳🇱 Амстердам, Нидерланды, Extra":  routeProxy,
		"🇪🇺 Автовыбор":                     routeProxy,
	}
	for node, want := range cases {
		if got := c.class(node); got != want {
			t.Errorf("class(%q) = %q, want %q", node, got, want)
		}
	}
}

func TestRouteSeries(t *testing.T) {
	c := routeClassifier{bypass: regexp.MustCompile(wordsRE([]string{"обход"}))}
	buckets := []dimBucket{
		{T: 100, Dims: map[string]map[string]*dimStat{"outbound": {"DIRECT": {Up: 1, Down: 2}}}},
		{T: 200, Dims: map[string]map[string]*dimStat{"outbound": {"DIRECT": {Down: 10}, "Обход I": {Up: 5, Down: 5}, "⛓ X": {Down: 7}, "🇳🇱 NL": {Down: 3}}}},
	}
	s := routeSeries(buckets, 150, c)
	if len(s) != 1 || s[0] != (routePoint{T: 200, Direct: 10, Proxy: 3, Bypass: 10, Chain: 7}) {
		t.Errorf("routeSeries = %+v", s)
	}
}

func TestCycleStart(t *testing.T) {
	loc := time.UTC
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, loc)
	if got := cycleStart(bypassLimit{Day: 1}, now); !got.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, loc)) {
		t.Errorf("day 1: %v", got)
	}
	if got := cycleStart(bypassLimit{Day: 15}, now); !got.Equal(time.Date(2026, 9, 15, 0, 0, 0, 0, loc)) {
		t.Errorf("day 15: %v", got)
	}
}

func TestDimKeysBypassUse(t *testing.T) {
	c := routeClassifier{bypass: regexp.MustCompile(wordsRE([]string{"lte"}))}
	var conn mihomoConn
	conn.Metadata.SourceIP = "192.168.1.5"
	conn.Metadata.Host = "www.youtube.com"
	conn.Chains = []string{"🇫🇮 LTE #1", "Обходы", "Быстрые", "AUTO"}
	keys := dimKeys(conn, c)
	if keys["bypass_use"] != "192.168.1.5|youtube.com|AUTO" {
		t.Errorf("bypass_use = %q", keys["bypass_use"])
	}
	conn.Chains = []string{"🇳🇱 NL", "AUTO"}
	if k := dimKeys(conn, c)["bypass_use"]; k != "" {
		t.Errorf("direct server counted as bypass: %q", k)
	}
}
