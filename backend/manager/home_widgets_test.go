package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// NPM-66: the services widget and the attention list read the last checks only.
func TestHomeServicesWidgetAndAttention(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MIHOMO_STATE_DIR", dir)
	old := services
	t.Cleanup(func() { services = old })
	services = newServiceChecker(filepath.Join(dir, "services.json"))
	a := &app{}
	if w := a.widgetServices(); w.State != "unknown" {
		t.Fatalf("nothing checked yet: %+v", w)
	}
	for _, def := range serviceList() {
		h := []serviceResult{{T: 100, OK: true}}
		if def.ID == "telegram" {
			h = []serviceResult{{T: 100, OK: true}, {T: 220, OK: false, Error: "нет ответа за 8 с"}, {T: 340, OK: false, Error: "нет ответа за 8 с"}}
		}
		services.states[def.ID] = &serviceState{serviceDef: def, History: h}
	}
	w := a.widgetServices()
	total := len(serviceList())
	if w.State != "warn" || !strings.Contains(w.Note, "Telegram") {
		t.Fatalf("services widget: %+v", w)
	}
	if v := w.Body.(map[string]any)["value"]; v != fmt.Sprintf("%d из %d", total-1, total) {
		t.Fatalf("value %v", v)
	}
	var found *attentionItem
	for _, it := range a.summaryAttention() {
		if it.ID == "service-telegram" {
			it := it
			found = &it
		}
	}
	if found == nil || found.Severity != "warning" || found.Since != stamp(220) || found.Action["page"] != "vpnsvc" {
		t.Fatalf("attention: %+v", found)
	}
}

func TestHomeGB(t *testing.T) {
	for in, want := range map[int64]string{0: "0,0", 1 << 29: "0,5", 255*(1<<30) + (1 << 29): "256"} {
		if got := gb(in); got != want {
			t.Errorf("%d → %s, want %s", in, got, want)
		}
	}
}

// NPM-68: the share of minutes each node worked, and the widget's distribution.
func TestHomeServerReliability(t *testing.T) {
	old := traffic
	t.Cleanup(func() { traffic = old })
	traffic = newTrafficCollector(filepath.Join(t.TempDir(), "traffic.json"), time.Now())
	yes, no := true, false
	start := time.Now().Add(-90 * time.Minute).Truncate(time.Minute)
	for i := 0; i < 90; i++ {
		a := &adaptiveSnapshot{Mode: "normal", Results: map[string]adaptiveResult{}}
		half := &no
		if i%2 == 0 {
			half = &yes
		}
		a.Results["good"] = adaptiveResult{Available: &yes}
		a.Results["half"] = adaptiveResult{Available: half}
		a.Results["dead"] = adaptiveResult{OK: false}
		a.Results["skipped"] = adaptiveResult{Skipped: "mode"}
		traffic.observeHealth(start.Add(time.Duration(i)*time.Minute), map[string]providerSnapshot{"ROUTER": {Adaptive: a, Proxies: make([]proxySnapshot, 4)}})
	}
	provider, shares := traffic.reliability(start.Add(90 * time.Minute))
	if provider != "ROUTER" || len(shares) != 3 || shares[0] != 0 || shares[2] != 1 || shares[1] < 0.45 || shares[1] > 0.55 {
		t.Fatalf("%s %v", provider, shares)
	}
	w := (&app{}).widgetReliability()
	bars := w.Body.(map[string]any)["bars"].([]map[string]any)
	if w.State != "warn" || bars[0]["value"] != 1 || bars[9]["value"] != 1 || !strings.Contains(w.Note, "1 из 3") {
		t.Fatalf("%+v", w)
	}
	// a node gone for more than a day is forgotten
	h := traffic.st.Health["ROUTER"]
	h.observeNodes(start.Add(26*time.Hour).Unix(), &adaptiveSnapshot{})
	if len(h.Nodes) != 0 {
		t.Fatalf("stale nodes kept: %d", len(h.Nodes))
	}
}
