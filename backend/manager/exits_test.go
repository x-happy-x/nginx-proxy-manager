package main

import "testing"

func TestExitTargetPath(t *testing.T) {
	if got := (exitTarget{Provider: "olcrtc", Name: "OLC jitsi/datachannel"}).path(); got != "/providers/proxies/olcrtc/OLC%20jitsi%2Fdatachannel/exit" {
		t.Fatalf("provider path: %s", got)
	}
	if got := (exitTarget{Name: "TS-HOME"}).path(); got != "/proxies/TS-HOME/exit" {
		t.Fatalf("proxy path: %s", got)
	}
}

func TestExitPendingNewAndForgotten(t *testing.T) {
	now := int64(10_000_000)
	e := &exitState{st: exitStore{Nodes: map[string]exitRecord{
		"known":   {CC: "NL", T: now - 100, Seen: now - 100},
		"gone":    {CC: "DE", Seen: now - exitKeepMissing - 1},
		"missing": {CC: "FI", Seen: now - 3600},
	}}}
	fresh := e.pending([]exitTarget{{Provider: "R", Name: "known"}, {Provider: "R", Name: "new"}}, now)
	if len(fresh) != 1 || fresh[0].Name != "new" {
		t.Fatalf("fresh: %+v", fresh)
	}
	if _, ok := e.st.Nodes["gone"]; ok {
		t.Fatal("a node absent for two weeks must be forgotten")
	}
	if _, ok := e.st.Nodes["missing"]; !ok {
		t.Fatal("a node absent for an hour must be kept")
	}
	if e.st.Nodes["known"].Seen != now || e.st.Nodes["known"].Provider != "R" {
		t.Fatalf("known not touched: %+v", e.st.Nodes["known"])
	}
}

func TestExitSkipTypes(t *testing.T) {
	for _, ty := range []string{"Direct", "Reject", "Dns", "Compatible"} {
		if !exitSkipType(ty) {
			t.Fatalf("%s must be skipped", ty)
		}
	}
	for _, ty := range []string{"Vless", "OlcRTC", "Tailscale"} {
		if exitSkipType(ty) {
			t.Fatalf("%s must be asked", ty)
		}
	}
}
