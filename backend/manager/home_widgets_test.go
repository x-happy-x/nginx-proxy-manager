package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
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
