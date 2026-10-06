package main

import (
	"testing"
	"time"
)

func snap(name, typ, now string, delays ...int) proxySnapshot {
	p := proxySnapshot{Name: name, Type: typ, Now: now}
	for _, d := range delays {
		p.History = append(p.History, struct {
			Delay int `json:"delay"`
		}{d})
	}
	return p
}

func TestObserveGroupsFollowsTheChoiceToTheNode(t *testing.T) {
	tc := &trafficCollector{live: map[string]liveConn{}}
	now := time.Date(2026, 10, 6, 18, 40, 0, 0, time.UTC)
	px := map[string]proxySnapshot{
		"AUTO":      snap("AUTO", "Fallback", "Обходы"),
		"Обходы":    snap("Обходы", "Fallback", "bypass-1"),
		"Подписки":  snap("Подписки", "Fallback", "DIRECT"),
		"DIRECT":    snap("DIRECT", "Direct", "", 5),
		"Скрытая":   {Name: "Скрытая", Type: "Fallback", Now: "bypass-1", Hidden: true},
		"bypass-77": snap("bypass-77", "Vless", ""),
	}
	providers := map[string]providerSnapshot{
		"ROUTER": {VehicleType: "HTTP", UpdatedAt: "2026-10-06T18:39:00Z", Proxies: []proxySnapshot{snap("bypass-1", "Vless", "", 120, 340)}},
	}
	providers["ROUTER"].Proxies[0].Alive = true
	tc.observeGroups(now, px, providers)
	rep := tc.groupsReport("24h", now.Add(time.Minute))
	groups := rep["groups"].(map[string][]latRow)
	if g := groups["AUTO"]; len(g) != 1 || g[0].MS != 340 || g[0].Node != "bypass-1" {
		t.Fatalf("AUTO = %+v", g)
	}
	if _, ok := groups["Скрытая"]; ok {
		t.Fatal("hidden group recorded")
	}
	logs := rep["provider_log"].(map[string][]provUpdate)
	if l := logs["ROUTER"]; len(l) != 1 || l[0].Total != 1 || l[0].Alive != 1 {
		t.Fatalf("log = %+v", l)
	}
	// the same update seen again adds nothing; a new one knows the path and the difference
	tc.observeGroups(now.Add(time.Minute), px, providers)
	providers["ROUTER"] = providerSnapshot{VehicleType: "HTTP", UpdatedAt: "2026-10-06T18:41:30Z", Proxies: []proxySnapshot{snap("bypass-1", "Vless", "", 0), snap("bypass-2", "Vless", "")}}
	tc.observeGroups(now.Add(2*time.Minute), px, providers)
	l := tc.groupsReport("24h", now.Add(3*time.Minute))["provider_log"].(map[string][]provUpdate)["ROUTER"]
	if len(l) != 2 || l[1].Added != 1 || l[1].Via != "DIRECT" {
		t.Fatalf("log = %+v", l)
	}
	// a failed check counts as a failure, not as a zero delay
	g := tc.groupsReport("24h", now.Add(3*time.Minute))["groups"].(map[string][]latRow)["Обходы"]
	if last := g[len(g)-1]; last.Fail != 1 || last.MS != 0 {
		t.Fatalf("Обходы = %+v", g)
	}
}

func TestObserveCountsEmptyConnections(t *testing.T) {
	tc := &trafficCollector{live: map[string]liveConn{}}
	now := time.Date(2026, 10, 6, 18, 0, 0, 0, time.UTC)
	conn := func(id string, up, down int64) mihomoConn {
		c := mihomoConn{ID: id, Upload: up, Download: down}
		c.Metadata.Network = "tcp"
		return c
	}
	tc.observe(now, 0, 0, nil)
	tc.observe(now.Add(5*time.Second), 0, 0, []mihomoConn{conn("a", 500, 0), conn("b", 500, 9000)})
	tc.observe(now.Add(10*time.Second), 0, 0, nil)
	h := tc.st.Hours[len(tc.st.Hours)-1]
	if h.Closed != 2 || h.Empty != 1 {
		t.Fatalf("hour = %+v", h)
	}
}

func TestHealthRecordsSubscriptionsWithoutAdaptive(t *testing.T) {
	tc := &trafficCollector{live: map[string]liveConn{}}
	now := time.Date(2026, 10, 6, 18, 0, 0, 0, time.UTC)
	a, b := snap("a", "Vless", ""), snap("b", "Vless", "")
	a.Alive = true
	tc.observeHealth(now, map[string]providerSnapshot{
		"CHAIN": {VehicleType: "HTTP", Proxies: []proxySnapshot{a, b}},
		"AUTO":  {VehicleType: "Compatible", Proxies: []proxySnapshot{a}},
	})
	if h := tc.st.Health["CHAIN"]; h == nil || h.Minutes[0].Working != 1 || h.Minutes[0].Total != 2 {
		t.Fatalf("CHAIN = %+v", tc.st.Health["CHAIN"])
	}
	if _, ok := tc.st.Health["AUTO"]; ok {
		t.Fatal("a group's own list recorded as a subscription")
	}
}

func TestTraceField(t *testing.T) {
	body := "fl=1\nip=203.0.113.7\nts=1\nloc=LT\n"
	if traceField(body, "loc") != "LT" || traceField(body, "ip") != "203.0.113.7" || traceField(body, "colo") != "" {
		t.Fatal("trace fields")
	}
}
